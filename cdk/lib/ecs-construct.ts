import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

interface EcsConstructProps {
    vpc: ec2.IVpc;
    logGroup: logs.ILogGroup;
    clusterName: string;
    dockerImagePath: string;
    containerEnvironment: { [key: string]: string };
    taskExecutionRoleArn: string;
    taskRoleArn: string;
}

export class EcsConstruct extends Construct {
    public readonly cluster: ecs.Cluster;
    public readonly taskDefinition: ecs.FargateTaskDefinition;
    public readonly container: ecs.ContainerDefinition;
    public readonly taskSecurityGroup: ec2.SecurityGroup;
    public readonly dockerImage: ecr_assets.DockerImageAsset;

    constructor(scope: Construct, id: string, props: EcsConstructProps) {
        super(scope, id);

        const { vpc, logGroup, clusterName, containerEnvironment, taskExecutionRoleArn, taskRoleArn } = props;
        const dockerImagePath = path.join(__dirname, '..', '..', 'java-scorer');

        // Import the manually created roles using their ARNs
        // 
        // REQUIRED PERMISSIONS FOR THESE ROLES:
        //
        // taskExecutionRole (ECS Task Execution Role):
        // - Trust Policy: Allow ecs-tasks.amazonaws.com to assume this role
        // - Managed Policies:
        //   * AmazonECSTaskExecutionRolePolicy (for pulling images from ECR, writing logs to CloudWatch)
        // - Resources: ECR repositories, CloudWatch log groups
        //
        // taskRole (ECS Task Role - Application Runtime Permissions):
        // - Trust Policy: Allow ecs-tasks.amazonaws.com to assume this role
        // - Managed Policies:
        //   * AmazonECSTaskExecutionRolePolicy (basic ECS permissions)
        //   * AmazonSSMReadOnlyAccess (for reading configuration from Parameter Store)
        // - Custom Inline Policies:
        //   * S3 Access: s3:GetObject, s3:PutObject on arn:aws:s3:::topcoder-submissions/*
        //   * CloudWatch Logs: logs:CreateLogStream, logs:PutLogEvents on /ecs/match-scorer log group
        // - Resources: S3 submission bucket, SSM parameters under /scorer/*, CloudWatch log streams
        //
        const taskExecutionRole = iam.Role.fromRoleArn(this, 'ImportedTaskExecutionRole', taskExecutionRoleArn);
        const taskRole = iam.Role.fromRoleArn(this, 'ImportedTaskRole', taskRoleArn);

        // --- ECS Cluster ---
        this.cluster = new ecs.Cluster(this, 'MatchScorerCluster', {
            vpc,
            clusterName: clusterName,
        });

        // --- ECS Task Definition ---
        this.taskDefinition = new ecs.FargateTaskDefinition(this, 'MatchScorerTask', {
            memoryLimitMiB: 512,
            cpu: 256,
            executionRole: taskExecutionRole,
            taskRole: taskRole,
            runtimePlatform: {
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
                cpuArchitecture: ecs.CpuArchitecture.X86_64,
            },
        });

        // --- Docker Image Asset ---
        this.dockerImage = new ecr_assets.DockerImageAsset(this, 'MatchScorerImage', {
            directory: dockerImagePath, // Use new java-scorer path
            platform: ecr_assets.Platform.LINUX_AMD64,
        });

        // --- ECS Container Definition ---
        this.container = this.taskDefinition.addContainer('MatchScorerContainer', {
            image: ecs.ContainerImage.fromDockerImageAsset(this.dockerImage),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'ecs',
                logGroup,
            }),
            environment: containerEnvironment,
        });

        // --- ECS Task Security Group ---
        this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
            vpc,
            description: 'Security group for the Match Scorer ECS task',
            allowAllOutbound: true,
        });
    }
} 