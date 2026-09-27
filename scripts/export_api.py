"""Export the actual FastAPI contract without requiring a running service."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from api.app import app
Path('docs/openapi.json').write_text(json.dumps(app.openapi(),ensure_ascii=False,indent=2)+'\n')
