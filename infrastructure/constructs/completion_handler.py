"""Completion handler Lambda construct for ECS task completion events."""
from aws_cdk import (
    aws_ec2 as ec2,
    aws_lambda as lambda_,
    aws_events as events,
    aws_events_targets as targets,
    aws_iam as iam,
    Duration
)
from constructs import Construct


class CompletionHandler(Construct):
    """Creates the Completion Lambda that handles ECS task completion events."""

    def __init__(
        self,
        scope: Construct,
        id: str,
        vpc: ec2.IVpc,
        ecs_cluster_arn: str,
        submission_api_url: str
    ):
        """Initialize the Completion Handler Lambda construct.

        Args:
            scope: CDK scope.
            id: Construct ID.
            vpc: VPC for Lambda placement.
            ecs_cluster_arn: ARN of the ECS cluster to monitor.
            submission_api_url: URL of the Submission API.
        """
        super().__init__(scope, id)

        # Lambda function
        self.function = lambda_.Function(self, 'CompletionFunction',
            function_name='mm-completion-lambda',
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler='handler.handler',
            code=lambda_.Code.from_asset('../completion_lambda'),
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS),
            timeout=Duration.seconds(60),
            memory_size=256,
            environment={
                'SUBMISSION_API_URL': submission_api_url
            }
        )

        # Grant permissions to read from SSM Parameter Store (for auth token)
        self.function.add_to_role_policy(iam.PolicyStatement(
            actions=['ssm:GetParameter'],
            resources=[
                'arn:aws:ssm:*:*:parameter/mm-processor/auth0/token'
            ]
        ))

        # EventBridge rule to capture ECS task state changes
        self.completion_rule = events.Rule(self, 'EcsTaskCompletionRule',
            rule_name='mm-ecs-task-completion',
            event_pattern=events.EventPattern(
                source=['aws.ecs'],
                detail_type=['ECS Task State Change'],
                detail={
                    'clusterArn': [ecs_cluster_arn],
                    'lastStatus': ['STOPPED'],
                    'group': [{'prefix': 'family:mm-scorer'}]
                }
            )
        )

        # Add Lambda as target for EventBridge rule
        self.completion_rule.add_target(targets.LambdaFunction(self.function))
