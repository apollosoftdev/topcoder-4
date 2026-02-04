import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';

export interface MskConstructProps {
  vpc: ec2.IVpc;
  clusterName: string;
  existingMskClusterArn?: string;
  existingMskSecurityGroupId?: string; // Security group ID for existing MSK cluster
  privateSubnetIds?: string[]; // Specific subnet IDs to use for MSK
}

export class MskConstruct extends Construct {
  public readonly mskClusterArn: string;
  public readonly mskSecurityGroup?: ec2.ISecurityGroup; // Security group for existing MSK cluster

  constructor(scope: Construct, id: string, props: MskConstructProps) {
    super(scope, id);

    const { vpc, clusterName, existingMskClusterArn, existingMskSecurityGroupId, privateSubnetIds } = props;

    if (existingMskClusterArn) {
      // Use existing MSK cluster
      console.log(`Using existing MSK cluster: ${existingMskClusterArn}`);
      this.mskClusterArn = existingMskClusterArn;

      if (existingMskSecurityGroupId) {
        // Use provided security group ID (recommended approach)
        this.mskSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
          this,
          'ExistingMskSecurityGroup',
          existingMskSecurityGroupId
        );
        console.log(`Using provided MSK security group: ${existingMskSecurityGroupId}`);
      } else {
        // Fallback: Try to lookup by naming convention (may not work for all setups)
        const clusterNameFromArn = existingMskClusterArn.split('/')[1];
        
        try {
          this.mskSecurityGroup = ec2.SecurityGroup.fromLookupByName(
            this,
            'ExistingMskSecurityGroup',
            `${clusterNameFromArn}-msk-sg`, // Common naming pattern
            vpc
          );
          console.log(`Found MSK security group by name: ${clusterNameFromArn}-msk-sg`);
        } catch (error) {
          console.log(`Could not find MSK security group by name. Please provide EXISTING_MSK_SECURITY_GROUP_ID`);
          this.mskSecurityGroup = undefined;
        }
      }
    } else {
      // Create new MSK cluster
      console.log('Creating new MSK cluster without security groups');

      // --- MSK Configuration (for auto topic creation) ---
      const mskConfiguration = new msk.CfnConfiguration(this, 'MskConfiguration', {
        name: `${clusterName}-config`,
        serverProperties: 'auto.create.topics.enable=true\n', // Use \n for newline if adding more prop
      });

      // --- MSK Cluster --- 
      const mskCluster = new msk.CfnCluster(this, 'MatchScorerMSKCluster', {
        clusterName: clusterName,
        kafkaVersion: '3.4.0',
        numberOfBrokerNodes: 2,
        brokerNodeGroupInfo: {
          instanceType: 'kafka.t3.small',
          clientSubnets: privateSubnetIds || vpc.privateSubnets.map(subnet => subnet.subnetId),
          // No security groups assigned - MSK will use VPC default security group
          storageInfo: {
            ebsStorageInfo: { volumeSize: 100 },
          },
        },
        encryptionInfo: {
          encryptionInTransit: {
            clientBroker: 'TLS',
            inCluster: true,
          },
        },
        // Associate the configuration with the cluster
        configurationInfo: {
          arn: mskConfiguration.attrArn,
          revision: mskConfiguration.attrLatestRevisionRevision,
        }
      });

      this.mskClusterArn = mskCluster.attrArn;
      // For new MSK clusters, no specific security group is assigned
      this.mskSecurityGroup = undefined;
    }
    
    if (this.mskSecurityGroup) {
      console.log('MSK security group available for Lambda configuration');
    } else {
      console.log('No MSK security group - Lambda will use VPC security groups');
    }
  }
}
