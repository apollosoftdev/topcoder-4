#!/bin/bash

# Script to prepare Lambda for deployment without Docker bundling
# Run this before CDK deployment in CI/CD

echo "Preparing Lambda for deployment..."

# Install production dependencies
npm ci --only=production --no-audit --no-fund

# Remove development files
rm -f *.test.js *.spec.js
rm -rf __tests__/
rm -f tsconfig.json
rm -f jest.config.js

echo "Lambda prepared for deployment"
echo "Contents:"
ls -la

echo "Node modules size:"
du -sh node_modules/ 2>/dev/null || echo "No node_modules directory"