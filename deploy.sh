#!/bin/bash

export CDK_DEFAULT_ACCOUNT=${AWS_ACCOUNT_ID}
export CDK_DEFAULT_REGION=${AWS_REGION}
cd submission-watcher-lambda
npm ci --only=production --no-audit --no-fund
cd ..
export SIMPLE_BUNDLING=true
export CI=true
cd cdk
npm install
npm run build
npm run deploy

