#!/bin/sh
set -eu
NODE=${MGU_NODE22:-/var/opt/jap-node22/current/bin/node}
"$NODE" --check home_bridge.js
