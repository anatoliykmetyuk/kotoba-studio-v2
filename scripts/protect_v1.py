import hashlib,json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
baseline=json.loads((root/'.runtime/v1-checksums.json').read_text())
changed=[p for p,h in baseline.items() if not Path(p).is_file() or hashlib.sha256(Path(p).read_bytes()).hexdigest()!=h]
print(json.dumps({'protectedFiles':len(baseline),'changed':changed},indent=2))
sys.exit(bool(changed))
