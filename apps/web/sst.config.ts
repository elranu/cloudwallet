import { LOG_GROUP_NAME } from '@/shared/utils/constants';
import { SSTConfig } from 'sst';
import { App, StackContext } from 'sst/constructs';
import { Cognito, Config, NextjsSite, Script, Table } from 'sst/constructs';
import { check } from '@/shared/utils/general';
import { AccountRecovery, AdvancedSecurityMode, Mfa, OAuthScope } from 'aws-cdk-lib/aws-cognito';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { KMSKey } from './pulumi/kms-construct';
import { createCloudWatch, createLogGroupName } from './sst/cloudwatch-v3';
import crypto from 'crypto';
import { customRandom } from 'nanoid';
import seedrandom from 'seedrandom';

const localhostUrl = 'http://localhost:3000';

const installationConfig = {
  email: check<string>(process.env.EMAIL, 'EMAIL'),
  phoneNumber: process.env.PHONE_NUMBER,
  region: check<string>(process.env.REGION, 'REGION'),
  suffix: getDeterministicRandomString(
    check<string>(process.env.EMAIL, 'EMAIL') + check<string>(process.env.REGION, 'REGION'),
  ),
  numberOfKeys: process.env.NUMBER_OF_KEYS ? parseInt(process.env.NUMBER_OF_KEYS, 10) : 1,
};

const name = `llavero${installationConfig.suffix}`;

function aliasName(stack: StackContext['stack'], index: number): string {
  return `${stack.stackName}/key-${index}`;
}

const config: SSTConfig = {
  config(_input: Record<string, string>) {
    return {
      name: name,
      region: installationConfig.region,
    };
  },
  stacks(app: App) {
    return async ({ stack }: StackContext) => {
      // Create KMS keys using Pulumi
      const keys = Array.from({ length: installationConfig.numberOfKeys }).map(
        (_, i) =>
          new KMSKey(`key-${i}`, {
            alias: aliasName(stack, i),
            description: `Llavero KMS Key ${i}`,
            keySpec: 'ECC_SECG_P256K1', // Required for blockchain signing
          }),
      );

      // Create log group
      const logGroup = createCloudWatch(stack, `${LOG_GROUP_NAME}ID`, {
        name: createLogGroupName(stack, LOG_GROUP_NAME),
      });

      // Create user table
      const userTable = new Table(stack, 'UserData', {
        fields: {
          pk: 'string',
          sk: 'string',
        },
        primaryIndex: { partitionKey: 'pk', sortKey: 'sk' },
        cdk: {
          table: {
            encryption: TableEncryption.AWS_MANAGED,
          },
        },
      });

      // Create Cognito auth
      const auth = new Cognito(stack, 'LlaveroPool', {
        login: ['email', 'username', 'preferredUsername', 'phone'],
        cdk: {
          userPool: {
            selfSignUpEnabled: false,
            signInAliases: { email: true },
            accountRecovery: AccountRecovery.EMAIL_ONLY,
            advancedSecurityMode: AdvancedSecurityMode.ENFORCED,
            mfa: Mfa.OPTIONAL,
            mfaSecondFactor: { otp: true, sms: true },
            standardAttributes: {
              email: { required: true, mutable: true },
              phoneNumber: { required: true, mutable: true },
            },
            enableSmsRole: true,
            snsRegion: installationConfig.region,
            passwordPolicy: {
              minLength: 8,
              requireDigits: true,
              requireLowercase: true,
              requireSymbols: true,
              requireUppercase: true,
            },
          },
          userPoolClient: {
            generateSecret: true,
            authFlows: {
              userPassword: true,
              userSrp: true,
            },
            oAuth: {
              callbackUrls: [`${localhostUrl}/api/auth/callback/cognito`],
              logoutUrls: [`${localhostUrl}/api/auth/signout`],
              scopes: [
                OAuthScope.EMAIL,
                OAuthScope.OPENID,
                OAuthScope.custom('aws.cognito.signin.user.admin'),
                OAuthScope.PROFILE,
              ],
              flows: {
                authorizationCodeGrant: true,
                implicitCodeGrant: true,
              },
            },
          },
        },
      });

      auth.cdk.userPool.addDomain('LlaveroDomain', {
        cognitoDomain: {
          domainPrefix: name + app.stage,
        },
      });

      // Create site URL parameter
      const SITE_URL = new Config.Parameter(stack, 'LLAVERO_URL', {
        value: 'emptyyyy',
      });

      // Create Next.js site
      const site = new NextjsSite(stack, 'Llavero', {
        bind: [logGroup, userTable, auth, SITE_URL, ...keys],
        environment: {
          LOG_GROUP_NAME: logGroup.value,
          USER_TABLE_NAME: userTable.tableName,
          USER_POOL_ID: auth.userPoolId,
          USER_POOL_CLIENT_ID: auth.userPoolClientId,
          COGNITO_POOL_ID: auth.cognitoIdentityPoolId ?? 'empty',
          POOL_SECRET: auth.cdk.userPoolClient.userPoolClientSecret.toString() ?? 'empty',
          NEXTAUTH_SECRET: randomString(16),
          SITEURL_PARAM_NAME: SITE_URL.name,
          REGION: installationConfig.region,
          NEXT_PUBLIC_REGION: installationConfig.region,
          NEXT_PUBLIC_USER_POOL_CLIENT_ID: auth.userPoolClientId,
          NEXT_PUBLIC_USER_POOL_ID: auth.userPoolId,
          NEXT_PUBLIC_COGNITO_POOL_ID: auth.cognitoIdentityPoolId ?? 'empty',
        },
      });

      site.attachPermissions([
        new PolicyStatement({
          actions: ['ssm:GetParameter'],
          effect: Effect.ALLOW,
          resources: [SITE_URL.arn],
        }),
        new PolicyStatement({
          actions: ['cognito-idp:UpdateUserPoolClient'],
          effect: Effect.ALLOW,
          resources: [auth.userPoolArn],
        }),
        new PolicyStatement({
          actions: [
            'sns:CreateSMSSandboxPhoneNumber',
            'sns:VerifySMSSandboxPhoneNumber',
            'sns:ListSMSSandboxPhoneNumbers',
            'sns:DeleteSMSSandboxPhoneNumber',
          ],
          effect: Effect.ALLOW,
          resources: ['*'],
        }),
      ]);

      // Initialize user table with Pulumi KMS keys
      const script = new Script(stack, 'AfterDeploy', {
        onCreate: `${process.cwd()}/src/repositories/user-table-init.main`,
        onUpdate: `${process.cwd()}/src/repositories/user-table-init.main`,
        params: {
          tableName: userTable.tableName,
          keys: keys.map((k) => ({ keyId: k.keyId, keyArn: k.keyArn })),
          cognitoPoolId: auth.userPoolId,
          UserPoolClientId: auth.userPoolClientId,
          config: installationConfig,
          arnSiteParameter: SITE_URL.name,
          siteUrl: site.url ?? localhostUrl,
        },
      });

      script.bind([userTable, logGroup, auth, SITE_URL, ...keys]);
      script.attachPermissions([
        new PolicyStatement({
          actions: ['dynamodb:*'],
          effect: Effect.ALLOW,
          resources: [userTable.tableArn],
        }),
        new PolicyStatement({
          actions: ['cognito-idp:*'],
          effect: Effect.ALLOW,
          resources: [auth.userPoolArn],
        }),
        new PolicyStatement({
          actions: ['ssm:PutParameter'],
          effect: Effect.ALLOW,
          resources: [SITE_URL.arn],
        }),
      ]);

      stack.addOutputs({
        finished: 'true',
      });
    };
  },
} satisfies SSTConfig;

export default config;

function randomString(length: number, justChars = false): string {
  let chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  if (!justChars) chars = `${chars}ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()_+~\`|}{[]:;?><,./-=`;
  const charsLength = chars.length;
  let password = '';

  for (let i = 0; i < length; i++) {
    const randomIndex = crypto.randomInt(0, charsLength);
    password += chars[randomIndex];
  }

  return password;
}

function getDeterministicRandomString(seed: string, max = 5): string {
  const rng = seedrandom(seed);
  const nanoid = customRandom('abcdefghijklmnopqrstuvwxyz0123456789', max, (size) => {
    return new Uint8Array(size).map(() => 256 * rng());
  });
  return nanoid();
}
