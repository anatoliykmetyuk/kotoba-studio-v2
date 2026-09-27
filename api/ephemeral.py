"""Bounded, process-local transport for explicitly requested phrase aids.

Every submission is independent. Nothing here is a corpus entity or a cache:
results exist only long enough for the requesting browser to retrieve them.
"""
import base64
import json
import threading
import time
from datetime import datetime, timedelta, timezone

from api import jobs
from api.graph import Conflict, Missing, now, packed, uid


class Capacity(ValueError):
    pass


class PhraseJobs:
    PREFIX = 'phrase-'
    MAX_JOBS = 128
    MAX_ACTIVE = 32
    MAX_AUDIO = 8 * 1024 * 1024
    MAX_AUDIO_TOTAL = 32 * 1024 * 1024
    REQUEST_SECONDS = 600
    RESULT_SECONDS = 300
    LEASE_SECONDS = 120

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.entries = {}
        self.audio_bytes = 0

    @classmethod
    def owns(cls, id):
        return id.startswith(cls.PREFIX)

    def _discard_audio(self, entry):
        self.audio_bytes -= len(entry.pop('audio', b''))

    def _fail(self, entry, error, current):
        self._discard_audio(entry)
        entry['job'].update(jobState='failed', error=error, result='{}', payload='{}', lease='', updatedAt=now())
        entry['expires'] = current + self.RESULT_SECONDS

    def _cleanup(self, current):
        for id, entry in list(self.entries.items()):
            state = entry['job']['jobState']
            if state in ('pending', 'running') and (
                current >= entry['expires'] or state == 'running' and current >= entry['lease']
            ):
                self._fail(entry, 'Phrase request timed out. Request it again.', current)
            elif state in ('ready', 'failed') and current >= entry['expires']:
                self._discard_audio(entry)
                del self.entries[id]

    def cleanup(self):
        with self.lock:
            self._cleanup(self.clock())

    def _get(self, id):
        entry = self.entries.get(id)
        if entry is None:
            raise Missing('Phrase request expired or the service restarted. Request it again.')
        return entry

    def submit(self, kind, payload):
        with self.lock:
            current = self.clock()
            self._cleanup(current)
            active = sum(e['job']['jobState'] in ('pending', 'running') for e in self.entries.values())
            if len(self.entries) >= self.MAX_JOBS or active >= self.MAX_ACTIVE:
                raise Capacity('Phrase tools are busy. Try again shortly.')
            id = self.PREFIX + uid()
            stamp = now()
            self.entries[id] = {
                'job': {'id': id, 'kind': kind, 'payload': packed(payload), 'result': '{}',
                        'jobState': 'pending', 'error': '', 'attempts': 0, 'lease': '',
                        'createdAt': stamp, 'updatedAt': stamp},
                'expires': current + self.REQUEST_SECONDS,
                'lease': 0,
            }
            return {'jobId': id}

    def view(self, id):
        with self.lock:
            self._cleanup(self.clock())
            return jobs.view(self._get(id)['job'])

    def claim(self, before=None):
        with self.lock:
            current = self.clock()
            self._cleanup(current)
            entry = next((e for e in self.entries.values()
                          if e['job']['jobState'] == 'pending'
                          and (before is None or e['job']['createdAt'] <= before)), None)
            if entry is None:
                return None
            job = entry['job']
            entry['lease'] = min(current + self.LEASE_SECONDS, entry['expires'])
            job.update(jobState='running', attempts=1, updatedAt=now(),
                       lease=(datetime.now(timezone.utc) + timedelta(seconds=entry['lease'] - current)).isoformat(),
                       result=packed({'_progress': jobs.progress('starting', 0, 0, now())}))
            return job | {'payload': json.loads(job['payload'])}

    def _running(self, id, attempt):
        entry = self._get(id)
        if entry['job']['jobState'] != 'running' or entry['job']['attempts'] != attempt:
            raise Conflict('Phrase request lease changed or expired')
        return entry

    def heartbeat(self, id, attempt):
        with self.lock:
            current = self.clock()
            self._cleanup(current)
            entry = self._running(id, attempt)
            entry['lease'] = min(current + self.LEASE_SECONDS, entry['expires'])
            entry['job'].update(lease=(datetime.now(timezone.utc) + timedelta(seconds=entry['lease'] - current)).isoformat())
            return {'state': 'running'}

    def cancel(self, id):
        with self.lock:
            entry = self.entries.get(id)
            if entry and entry['job']['jobState'] in ('pending', 'running'):
                self._fail(entry, 'Phrase playback cancelled. Request it again.', self.clock())

    def complete(self, id, attempt, result, error=''):
        with self.lock:
            current = self.clock()
            self._cleanup(current)
            entry = self._running(id, attempt)
            if error:
                self._fail(entry, error[:2000], current)
                return {'state': 'failed'}
            try:
                if entry['job']['kind'] == 'translation':
                    translation = result.get('translation')
                    if not isinstance(translation, str) or not translation.strip() or len(translation) > 10000:
                        raise ValueError('Worker did not return a valid translation')
                    output = {'translation': translation}
                else:
                    encoded = result.get('audio')
                    if not isinstance(encoded, str) or len(encoded) > 4 * ((self.MAX_AUDIO + 2) // 3):
                        raise ValueError('Phrase audio exceeds the transport limit')
                    audio = base64.b64decode(encoded, validate=True)
                    if len(audio) > self.MAX_AUDIO or not audio.startswith(b'RIFF') or audio[8:12] != b'WAVE':
                        raise ValueError('Worker did not return valid WAV audio')
                    if self.audio_bytes + len(audio) > self.MAX_AUDIO_TOTAL:
                        raise ValueError('Phrase audio transport is full. Request it again shortly.')
                    entry['audio'] = audio
                    self.audio_bytes += len(audio)
                    output = {'url': '/api/v1/phrase-tools/audio/' + id}
            except ValueError as exc:
                self._fail(entry, str(exc), current)
                return {'state': 'failed'}
            entry['job'].update(jobState='ready', result=packed(output), error='', lease='', updatedAt=now())
            entry['expires'] = current + self.RESULT_SECONDS
            # Retain neither Japanese text nor context once inference finishes.
            entry['job']['payload'] = '{}'
            return output

    def audio(self, id):
        with self.lock:
            self._cleanup(self.clock())
            entry = self._get(id)
            if entry['job']['jobState'] != 'ready' or 'audio' not in entry:
                raise Missing('Phrase audio is unavailable. Request it again.')
            return entry['audio']
