"""Prepare project-owned Japanese speech assets, optionally reusing local copies."""
import argparse,hashlib,json,os,shutil,subprocess,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MODELS=ROOT/'data/models'
KOKORO_REVISION='a71e4d38b236d968966a2002c4c895dbd12b1c3c'


def ready(name,directory):
    required=(['config.json','kokoro-v1_0.safetensors','voices/jf_alpha.safetensors'] if name=='kokoro'
              else ['sys.dic','unk.dic','char.bin','matrix.bin','dicrc'])
    if not all((directory/file).is_file() and (directory/file).stat().st_size for file in required):return False
    if name=='kokoro':
        from safetensors import safe_open
        try:
            json.loads((directory/'config.json').read_text())
            for file in ('kokoro-v1_0.safetensors','voices/jf_alpha.safetensors'):
                with safe_open(directory/file,framework='np') as weights:
                    if not weights.keys():return False
        except Exception:return False
    return True


def prepare(kokoro_source=None,unidic_source=None):
    MODELS.mkdir(parents=True,exist_ok=True)
    os.environ['HF_HOME']=str(ROOT/'data/cache/huggingface')
    for name,source in [('kokoro',kokoro_source),('unidic',unidic_source)]:
        destination=MODELS/name
        if ready(name,destination):continue
        if source:
            shutil.copytree(source,destination,dirs_exist_ok=True,ignore=shutil.ignore_patterns('.cache','__pycache__'))
        elif name=='kokoro':
            from huggingface_hub import snapshot_download
            snapshot_download('mlx-community/Kokoro-82M-bf16',revision=KOKORO_REVISION,local_dir=destination)
        else:
            import unidic
            source=Path(unidic.DICDIR)
            if not ready('unidic',source):
                # The virtual environment is inside this repository, so the
                # upstream download and its temporary files remain local too.
                subprocess.run([sys.executable,'-m','unidic','download'],cwd=ROOT,check=True)
            shutil.copytree(source,destination,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))
    if not ready('kokoro',MODELS/'kokoro') or not ready('unidic',MODELS/'unidic'):
        raise SystemExit('Speech assets are incomplete. Inspect data/models before retrying.')
    manifest={}
    for name in ('kokoro','unidic'):
        for file in sorted((MODELS/name).rglob('*')):
            if file.is_file() and '.cache' not in file.parts:
                with file.open('rb') as stream:manifest[str(file.relative_to(MODELS))]=hashlib.file_digest(stream,'sha256').hexdigest()
    (MODELS/'manifest.json').write_text(json.dumps(manifest,indent=2))
    print('Assets prepared:',len(manifest),'files. Existing source assets unchanged.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kokoro-source',type=Path)
    parser.add_argument('--unidic-source',type=Path)
    args=parser.parse_args();prepare(args.kokoro_source,args.unidic_source)
