#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MatchScorerCdkStack } from '../lib/match-scorer-cdk-stack';

const app = new cdk.App();
new MatchScorerCdkStack(app, 'MatchScorerStack', {
  /* Specify the environment for account/region-dependent features like VPC lookups */
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },

  /* Alternative: Specify exact account and region if known
   * env: { account: '123456789012', region: 'us-east-1' },
   * 
   * Or use environment variables for explicit control:
   * env: { 
   *   account: process.env.AWS_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT, 
   *   region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION 
   * },
   */
}); 