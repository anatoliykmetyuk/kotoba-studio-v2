#!/bin/bash
set -euo pipefail
exec sbcl --dynamic-space-size 2048 --noinform --non-interactive --load /app/server.lisp
