"""Process-local wakeups for the durable and temporary worker queues."""
import asyncio


class WorkerWakeup:
    # Fallback reads also discover expired durable leases and jobs written by
    # another API process. Notifications are an optimization, not queue state.
    RESCAN_SECONDS = 5

    def __init__(self):
        self.loop = asyncio.get_running_loop()
        self.revision = 0
        self.event = asyncio.Event()

    def notify(self):
        self.loop.call_soon_threadsafe(self._notify)

    def _notify(self):
        self.revision += 1
        self.event.set()
        self.event = asyncio.Event()

    async def wait(self, revision, timeout):
        # Capture revision before scanning the queue so a submission between
        # the scan and wait cannot disappear into a cleared event.
        if self.revision != revision:
            return
        try:
            await asyncio.wait_for(self.event.wait(), timeout)
        except TimeoutError:
            pass
