#!/usr/bin/env python3
"""CDK app entry point for the Marathon Match processor."""
import os
import aws_cdk as cdk

from mm_processor_stack import MmProcessorStack


app = cdk.App()

# Get configuration from context or environment
vpc_id = app.node.try_get_context('vpc_id') or os.environ.get('VPC_ID')
msk_cluster_arn = app.node.try_get_context('msk_cluster_arn') or os.environ.get('MSK_CLUSTER_ARN')
kafka_topic = app.node.try_get_context('kafka_topic') or os.environ.get('KAFKA_TOPIC', 'submissions')
kafka_bootstrap_servers = app.node.try_get_context('kafka_bootstrap_servers') or os.environ.get('KAFKA_BOOTSTRAP_SERVERS')
ecs_cluster_arn = app.node.try_get_context('ecs_cluster_arn') or os.environ.get('ECS_CLUSTER_ARN')
submission_api_url = app.node.try_get_context('submission_api_url') or os.environ.get('SUBMISSION_API_URL')
ecs_subnets = (app.node.try_get_context('ecs_subnets') or os.environ.get('ECS_SUBNETS', '')).split(',')
ecs_security_group = app.node.try_get_context('ecs_security_group') or os.environ.get('ECS_SECURITY_GROUP')

# Challenge IDs can be passed as comma-separated string
challenge_ids_str = app.node.try_get_context('challenge_ids') or os.environ.get('CHALLENGE_IDS', '')
challenge_ids = [cid.strip() for cid in challenge_ids_str.split(',') if cid.strip()]

# Validate required configuration
if not vpc_id:
    raise ValueError("vpc_id is required. Set via context or VPC_ID environment variable.")
if not msk_cluster_arn:
    raise ValueError("msk_cluster_arn is required. Set via context or MSK_CLUSTER_ARN environment variable.")
if not kafka_bootstrap_servers:
    raise ValueError("kafka_bootstrap_servers is required. Set via context or KAFKA_BOOTSTRAP_SERVERS environment variable.")
if not ecs_cluster_arn:
    raise ValueError("ecs_cluster_arn is required. Set via context or ECS_CLUSTER_ARN environment variable.")
if not submission_api_url:
    raise ValueError("submission_api_url is required. Set via context or SUBMISSION_API_URL environment variable.")
if not ecs_security_group:
    raise ValueError("ecs_security_group is required. Set via context or ECS_SECURITY_GROUP environment variable.")
if not challenge_ids:
    raise ValueError("challenge_ids is required. Set via context or CHALLENGE_IDS environment variable.")

MmProcessorStack(app, 'MmProcessorStack',
    vpc_id=vpc_id,
    msk_cluster_arn=msk_cluster_arn,
    kafka_topic=kafka_topic,
    kafka_bootstrap_servers=kafka_bootstrap_servers,
    challenge_ids=challenge_ids,
    ecs_cluster_arn=ecs_cluster_arn,
    submission_api_url=submission_api_url,
    ecs_subnets=ecs_subnets,
    ecs_security_group=ecs_security_group,
    env=cdk.Environment(
        account=os.environ.get('CDK_DEFAULT_ACCOUNT'),
        region=os.environ.get('CDK_DEFAULT_REGION', 'us-east-1')
    )
)

app.synth()
