import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Port, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ContainerImage,
  FargateTaskDefinition,
  LogDriver,
  Secret as ecsSecret,
} from 'aws-cdk-lib/aws-ecs';
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  ECR_REPOSITORY_NAME,
  ECS_TASKS_URL,
  getVpc,
  RDS_SECRET_NAME_SSM_NAME,
  RDS_SECURITY_GROUP_ID_SSM_NAME,
  stageTitleCase,
} from './utils';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

interface DeploymentStackProps extends StackProps {
  stageName: string;
  imageTag: string;
}

export class DeploymentStack extends Stack {
  constructor(scope: Construct, id: string, props: DeploymentStackProps) {
    super(scope, id, props);
    const stageName = props.stageName as string;
    const stageTitle = stageTitleCase(stageName);
    const vpc = getVpc(this);

    const dbSecret = Secret.fromSecretNameV2(
      this,
      'dbSecret',
      StringParameter.valueFromLookup(this, RDS_SECRET_NAME_SSM_NAME)
    );

    const secretsManagerPermissions = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [dbSecret.secretArn],
    });

    const ecsCluster = new Cluster(this, `ECS${stageTitle}-Cluster`, { vpc });

    const executionRole = new Role(this, `${stageTitle}ExecutionRole`, {
      assumedBy: new ServicePrincipal(ECS_TASKS_URL),
    });
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: ['*'],
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
      })
    );

    const taskRole = new Role(this, `${stageTitle}TaskRole`, {
      assumedBy: new ServicePrincipal(ECS_TASKS_URL),
    });

    const taskDefinition = new FargateTaskDefinition(
      this,
      `TaskDef-${stageName}`,
      {
        memoryLimitMiB: 512,
        cpu: 256,
        executionRole: executionRole,
        taskRole: taskRole,
      }
    );

    taskDefinition.addToTaskRolePolicy(secretsManagerPermissions);

    const repository = Repository.fromRepositoryName(
      this,
      'ECR',
      ECR_REPOSITORY_NAME
    );
    const container = taskDefinition.addContainer(`${stageTitle}Container`, {
      image: ContainerImage.fromEcrRepository(repository, props.imageTag),
      environment: {
        FORCE_DEPLOYMENT_ENV_VAR: Date.now().toString(), // Add a changing env variable to force a new deployment
      },
      secrets: {
        DBHOST: ecsSecret.fromSecretsManager(dbSecret, 'host'),
        DBNAME: ecsSecret.fromSecretsManager(dbSecret, 'dbname'),
        DBUSER: ecsSecret.fromSecretsManager(dbSecret, 'username'),
        DBPASS: ecsSecret.fromSecretsManager(dbSecret, 'password'),
        DBPORT: ecsSecret.fromSecretsManager(dbSecret, 'port'),
      },
      logging: LogDriver.awsLogs({
        streamPrefix: `${stageTitle}Logs`,
        logRetention: RetentionDays.TWO_WEEKS,
      }),
    });

    container.addPortMappings({ containerPort: 3000 });

    const fargateSecurityGroup = new SecurityGroup(
      this,
      `${stageTitle}FargateSecurityGroup`,
      { vpc, allowAllOutbound: true }
    );

    // If we want the server to be a HTTPS server
    // We will need to setup Route 53 + certificate
    // and in that case, we can change the protocol to HTTPS
    // and the listener port to 443
    // Lastly, we can also redirect all HTTP traffic to HTTPS
    const fargateService = new ApplicationLoadBalancedFargateService(
      this,
      `${stageTitle}Service`,
      {
        cluster: ecsCluster,
        taskDefinition: taskDefinition,
        publicLoadBalancer: true,
        assignPublicIp: true,
        protocol: ApplicationProtocol.HTTP,
        listenerPort: 80,
        securityGroups: [fargateSecurityGroup],
        taskSubnets: { subnetType: SubnetType.PUBLIC },
      }
    );

    const rdsSecurityGroup = SecurityGroup.fromSecurityGroupId(
      this,
      `RDS${stageTitle}SecurityGroup`,
      StringParameter.valueFromLookup(this, RDS_SECURITY_GROUP_ID_SSM_NAME)
    );

    rdsSecurityGroup.connections.allowFrom(
      fargateSecurityGroup,
      Port.tcp(5432),
      'Allow traffic from fargate/ECS'
    );
    fargateSecurityGroup.connections.allowFrom(
      rdsSecurityGroup,
      Port.tcp(5432),
      'Allow traffic from RDS'
    );

    // Output the ALB DNS name
    new CfnOutput(this, `LoadBalancer${stageTitle}DNS`, {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });
  }
}
