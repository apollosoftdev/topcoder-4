"""Router Lambda construct for MSK message processing."""
from aws_cdk import (
    aws_ec2 as ec2,
    aws_lambda as lambda_,
    aws_sns as sns,
    aws_iam as iam,
    Duration
)
from aws_cdk.aws_lambda_event_sources import ManagedKafkaEventSource
from constructs import Construct


class RouterLambda(Construct):
    """Creates the Router Lambda that processes MSK messages and routes to SNS."""

    def __init__(
        self,
        scope: Construct,
        id: str,
        vpc: ec2.IVpc,
        msk_cluster_arn: str,
        kafka_topic: str,
        sns_topic: sns.ITopic,
        kafka_bootstrap_servers: str
    ):
        """Initialize the Router Lambda construct.

        Args:
            scope: CDK scope.
            id: Construct ID.
            vpc: VPC for Lambda placement.
            msk_cluster_arn: ARN of the MSK cluster.
            kafka_topic: Kafka topic name to consume from.
            sns_topic: SNS topic to publish messages to.
            kafka_bootstrap_servers: Bootstrap servers for MSK cluster.
        """
        super().__init__(scope, id)

        # Lambda function
        self.function = lambda_.Function(self, 'RouterFunction',
            function_name='mm-router-lambda',
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler='handler.handler',
            code=lambda_.Code.from_asset('../router_lambda'),
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS),
            timeout=Duration.seconds(60),
            memory_size=256,
            environment={
                'SNS_TOPIC_ARN': sns_topic.topic_arn
            }
        )

        # Grant permissions to publish to SNS
        sns_topic.grant_publish(self.function)

        # Grant permissions to read from MSK
        self.function.add_to_role_policy(iam.PolicyStatement(
            actions=[
                'kafka-cluster:Connect',
                'kafka-cluster:DescribeGroup',
                'kafka-cluster:AlterGroup',
                'kafka-cluster:DescribeTopic',
                'kafka-cluster:ReadData',
                'kafka-cluster:DescribeClusterDynamicConfiguration'
            ],
            resources=[
                msk_cluster_arn,
                f'{msk_cluster_arn}/*'
            ]
        ))

        # MSK event source
        self.function.add_event_source(
            ManagedKafkaEventSource(
                cluster_arn=msk_cluster_arn,
                topic=kafka_topic,
                starting_position=lambda_.StartingPosition.LATEST,
                batch_size=10
            )
        )
