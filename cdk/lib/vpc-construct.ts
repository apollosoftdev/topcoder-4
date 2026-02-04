import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface VpcConstructProps {
  existingVpcId?: string;
  existingPrivateSubnetIds?: string; // Comma-separated subnet IDs
  existingSecurityGroupIds?: string; // Comma-separated security group IDs
}

export class VpcConstruct extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly securityGroups: ec2.ISecurityGroup[];

  constructor(scope: Construct, id: string, props?: VpcConstructProps) {
    super(scope, id);

    if (props?.existingVpcId) {
      // Use existing VPC
      // console.log(`Using existing VPC: ${props.existingVpcId}`);
      
      // Import VPC
      this.vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
        vpcId: props.existingVpcId,
      });

      // Import private subnets if provided
      if (props.existingPrivateSubnetIds) {
        const privateSubnetIds = props.existingPrivateSubnetIds.split(',').map(s => s.trim());
        // console.log(`Using existing private subnets: ${privateSubnetIds.join(', ')}`);
        this.privateSubnets = privateSubnetIds.map((subnetId, index) =>
          ec2.Subnet.fromSubnetId(this, `PrivateSubnet${index}`, subnetId)
        );
      } else {
        // Use VPC's private subnets
        this.privateSubnets = this.vpc.privateSubnets;
      }

      // Import security groups if provided
      if (props.existingSecurityGroupIds) {
        const securityGroupIds = props.existingSecurityGroupIds.split(',').map(s => s.trim());
        // console.log(`Using existing security groups: ${securityGroupIds.join(', ')}`);
        this.securityGroups = securityGroupIds.map((sgId, index) =>
          ec2.SecurityGroup.fromSecurityGroupId(this, `SecurityGroup${index}`, sgId, {
            allowAllOutbound: true,
          })
        );
      } else {
        // No specific security groups provided
        this.securityGroups = [];
      }
    } else {
      // Create new VPC with private subnets only (public subnets for NAT Gateway)
      console.log('Creating new VPC');
      const newVpc = new ec2.Vpc(this, 'MatchScorerVpc', {
        maxAzs: 2,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: 'public-subnet',
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            cidrMask: 24,
            name: 'private-subnet',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
        natGateways: 1,
      });

      this.vpc = newVpc;
      // Only expose private subnets - public subnets are only for NAT Gateway
      this.privateSubnets = newVpc.privateSubnets;
      
      // Create a default security group for services (MSK, Lambda, ECS)
      const defaultSecurityGroup = new ec2.SecurityGroup(this, 'DefaultSecurityGroup', {
        vpc: newVpc,
        description: 'Default security group for Match Scorer services',
        allowAllOutbound: true,
      });

      // Allow internal communication within the security group
      defaultSecurityGroup.addIngressRule(
        defaultSecurityGroup,
        ec2.Port.allTraffic(),
        'Allow internal communication between services'
      );

      this.securityGroups = [defaultSecurityGroup];
    }
  }
} 