#!/bin/bash

set -e

DIRNAME="$(cd "$(dirname "$0")"; pwd)"
OUT_DIR_NODE=$DIRNAME/../packages/sdk/src/generated/node
OUT_DIR_WEB=$DIRNAME/../packages/sdk/src/generated/web
PROTOC=$DIRNAME/../node_modules/.bin/protoc
PROTOC_GRPC_PLUGIN=$DIRNAME/../node_modules/.bin/grpc_tools_node_protoc_plugin
PROTOC_GRPC_WEB_PLUGIN=$DIRNAME/../node_modules/.bin/protoc-gen-grpc-web
PROTOC_JS_PLUGIN=$DIRNAME/../node_modules/.bin/protoc-gen-js
PROTOC_TS_PLUGIN=$DIRNAME/../node_modules/.bin/protoc-gen-ts

echo "Generating code for protos"

mkdir -p $OUT_DIR_NODE
mkdir -p $OUT_DIR_WEB

# Node.js
"$PROTOC" -I=. $DIRNAME/../packages/common/src/protos/acls.proto \
  -I=. $DIRNAME/../packages/common/src/protos/agents.proto \
  -I=. $DIRNAME/../packages/common/src/protos/applications.proto \
  -I=. $DIRNAME/../packages/common/src/protos/calls.proto \
  -I=. $DIRNAME/../packages/common/src/protos/credentials.proto \
  -I=. $DIRNAME/../packages/common/src/protos/domains.proto \
  -I=. $DIRNAME/../packages/common/src/protos/identity.proto \
  -I=. $DIRNAME/../packages/common/src/protos/numbers.proto \
  -I=. $DIRNAME/../packages/common/src/protos/secrets.proto \
  -I=. $DIRNAME/../packages/common/src/protos/trunks.proto \
  -I=$DIRNAME/../packages/common/src/protos/ \
  --js_out=import_style=commonjs,binary:$OUT_DIR_NODE \
  --grpc_out=grpc_js:$OUT_DIR_NODE \
  --plugin=protoc-gen-grpc="$PROTOC_GRPC_PLUGIN" \
  --plugin=protoc-gen-js="$PROTOC_JS_PLUGIN" \
  --plugin=protoc-gen-ts="$PROTOC_TS_PLUGIN"

# Browser
"$PROTOC" -I=. $DIRNAME/../packages/common/src/protos/acls.proto \
  -I=. $DIRNAME/../packages/common/src/protos/agents.proto \
  -I=. $DIRNAME/../packages/common/src/protos/applications.proto \
  -I=. $DIRNAME/../packages/common/src/protos/calls.proto \
  -I=. $DIRNAME/../packages/common/src/protos/credentials.proto \
  -I=. $DIRNAME/../packages/common/src/protos/domains.proto \
  -I=. $DIRNAME/../packages/common/src/protos/identity.proto \
  -I=. $DIRNAME/../packages/common/src/protos/numbers.proto \
  -I=. $DIRNAME/../packages/common/src/protos/secrets.proto \
  -I=. $DIRNAME/../packages/common/src/protos/trunks.proto \
  -I=$DIRNAME/../packages/common/src/protos/ \
  --js_out=import_style=commonjs:$OUT_DIR_WEB \
  --grpc-web_out=import_style=typescript,mode=grpcwebtext:$OUT_DIR_WEB \
  --plugin=protoc-gen-grpc-web="$PROTOC_GRPC_WEB_PLUGIN" \
  --plugin=protoc-gen-js="$PROTOC_JS_PLUGIN" \
  --plugin=protoc-gen-ts="$PROTOC_TS_PLUGIN"
