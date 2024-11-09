import { Config } from 'sst/constructs';
import type { Stack } from 'sst/constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';

let logGroup: logs.LogGroup | undefined;

export interface CloudWatchProps {
  name: string;
  retention?: logs.RetentionDays;
  removalPolicy?: RemovalPolicy;
}

export function createCloudWatch(stack: Stack, id: string, props: CloudWatchProps) {
  // Return existing log group if already created (singleton pattern)
  if (logGroup) {
    return new Config.Parameter(stack, id, {
      value: props.name,
    });
  }

  // Create new log group with CDK construct
  logGroup = new logs.LogGroup(stack, `${id}-group`, {
    logGroupName: props.name,
    retention: props.retention ?? logs.RetentionDays.FIVE_DAYS,
    removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
  });

  // Create parameter for SST
  const parameter = new Config.Parameter(stack, id, {
    value: props.name,
  });

  // Attach permissions to the stack
  stack.addDefaultFunctionPermissions([
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['logs:*'],
      resources: [logGroup.logGroupArn],
    }),
  ]);

  return parameter;
}

// Helper function to create stage-specific names
export function createLogGroupName(stack: Stack, name: string): string {
  return stack.stage !== 'prod' ? `${stack.stage}-${name}` : name;
}
