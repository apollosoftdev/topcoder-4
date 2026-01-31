"""Challenge processor Lambda construct for ECS task launching."""
from aws_cdk import (
    aws_ec2 as ec2,
    aws_lambda as lambda_,
    aws_sqs as sqs,
    aws_iam as iam,
    Duration
)
from aws_cdk.aws_lambda_event_sources import SqsEventSource
from constructs import Construct


class ChallengeProcessor(Construct):
    """Creates a per-challenge Lambda that processes SQS messages and launches ECS tasks."""

    def __init__(
        self,
        scope: Construct,
        id: str,
        vpc: ec2.IVpc,
        queue: sqs.IQueue,
        challenge_id: str,
        ecs_cluster_arn: str,
        subnets: list[str],
        security_group: str
    ):
        """Initialize the Challenge Processor Lambda construct.

        Args:
            scope: CDK scope.
            id: Construct ID.
            vpc: VPC for Lambda placement.
            queue: SQS queue to consume messages from.
            challenge_id: The challenge ID this processor handles.
            ecs_cluster_arn: ARN of the ECS cluster to run tasks on.
            subnets: List of subnet IDs for ECS tasks.
            security_group: Security group ID for ECS tasks.
        """
        super().__init__(scope, id)

        # Lambda function
        self.function = lambda_.Function(self, 'ProcessorFunction',
            function_name=f'mm-challenge-{challenge_id}-lambda',
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler='handler.handler',
            code=lambda_.Code.from_asset('../challenge_lambda'),
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS),
            timeout=Duration.seconds(60),
            memory_size=256,
            environment={
                'CHALLENGE_ID': challenge_id,
                'SUBNETS': ','.join(subnets),
                'SECURITY_GROUP': security_group
            }
        )

        # Grant permissions to read from SQS
        queue.grant_consume_messages(self.function)

        # Grant permissions to read from SSM Parameter Store
        self.function.add_to_role_policy(iam.PolicyStatement(
            actions=['ssm:GetParameter'],
            resources=[
                f'arn:aws:ssm:*:*:parameter/mm-processor/challenges/{challenge_id}/config'
            ]
        ))

        # Grant permissions to run ECS tasks
        self.function.add_to_role_policy(iam.PolicyStatement(
            actions=[
                'ecs:RunTask',
                'ecs:DescribeTasks'
            ],
            resources=['*']
        ))

        # Grant permissions to pass role to ECS tasks
        self.function.add_to_role_policy(iam.PolicyStatement(
            actions=['iam:PassRole'],
            resources=['*'],
            conditions={
                'StringLike': {
                    'iam:PassedToService': 'ecs-tasks.amazonaws.com'
                }
            }
        ))

        # SQS event source
        self.function.add_event_source(
            SqsEventSource(queue,
                batch_size=10,
                max_batching_window=Duration.seconds(5)
            )
        )
