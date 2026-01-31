"""Main CDK stack for the Marathon Match processor."""
from aws_cdk import Stack
from aws_cdk import aws_ec2 as ec2
from constructs import Construct

from mm_constructs import (
    RouterLambda,
    FanoutConstruct,
    ChallengeProcessor,
    CompletionHandler
)


class MmProcessorStack(Stack):
    """CDK stack for the serverless Marathon Match processor architecture."""

    def __init__(
        self,
        scope: Construct,
        id: str,
        vpc_id: str,
        msk_cluster_arn: str,
        kafka_topic: str,
        kafka_bootstrap_servers: str,
        challenge_ids: list[str],
        ecs_cluster_arn: str,
        submission_api_url: str,
        ecs_subnets: list[str],
        ecs_security_group: str,
        **kwargs
    ):
        """Initialize the Marathon Match processor stack.

        Args:
            scope: CDK scope.
            id: Stack ID.
            vpc_id: VPC ID for resource placement.
            msk_cluster_arn: ARN of the MSK cluster.
            kafka_topic: Kafka topic name to consume from.
            kafka_bootstrap_servers: Bootstrap servers for MSK cluster.
            challenge_ids: List of challenge IDs to create processors for.
            ecs_cluster_arn: ARN of the ECS cluster for scorer tasks.
            submission_api_url: URL of the Submission API.
            ecs_subnets: List of subnet IDs for ECS tasks.
            ecs_security_group: Security group ID for ECS tasks.
            **kwargs: Additional stack properties.
        """
        super().__init__(scope, id, **kwargs)

        # 1. VPC lookup
        vpc = ec2.Vpc.from_lookup(self, 'Vpc', vpc_id=vpc_id)

        # 2. Fan-out infrastructure (SNS + SQS queues)
        fanout = FanoutConstruct(self, 'Fanout', challenge_ids=challenge_ids)

        # 3. Router Lambda with MSK event source
        RouterLambda(self, 'Router',
            vpc=vpc,
            msk_cluster_arn=msk_cluster_arn,
            kafka_topic=kafka_topic,
            sns_topic=fanout.topic,
            kafka_bootstrap_servers=kafka_bootstrap_servers
        )

        # 4. Per-challenge processor Lambdas
        for challenge_id in challenge_ids:
            ChallengeProcessor(self, f'Challenge-{challenge_id}',
                vpc=vpc,
                queue=fanout.queues[challenge_id],
                challenge_id=challenge_id,
                ecs_cluster_arn=ecs_cluster_arn,
                subnets=ecs_subnets,
                security_group=ecs_security_group
            )

        # 5. Completion handler Lambda
        CompletionHandler(self, 'Completion',
            vpc=vpc,
            ecs_cluster_arn=ecs_cluster_arn,
            submission_api_url=submission_api_url
        )
