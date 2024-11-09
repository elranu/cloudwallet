import { updateInviteMessageTemplate, updateUserPoolClientCallbackUrl } from '@/shared/utils/aws';
import { KmsKey, UserRepository } from './user-repository';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  UserType,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { AwsKmsSigner } from '@dennisdang/ethers-aws-kms-signer';
import { KMSClient } from '@dennisdang/ethers-aws-kms-signer/node_modules/@aws-sdk/client-kms';
import { JsonRpcProvider } from 'ethers';
import { EIP155_MAINNET_CHAINS } from '@/data/EIP155Data';

export interface ICloudWalletInitParams {
  tableName: string;
  keys: Array<{
    keyId: pulumi.Output<string>;
    keyArn: pulumi.Output<string>;
  }>;
  cognitoPoolId: string;
  UserPoolClientId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
  arnSiteParameter: string;
  siteUrl: string;
}

export async function main(event: { params: ICloudWalletInitParams }) {
  await UserRepository.updateTable(event.params.tableName);
  const userRepo = new UserRepository(event.params.tableName);
  await updateParameterStoreValue(
    event.params.arnSiteParameter,
    event.params.siteUrl,
    event.params.config.region,
  );
  if (event.params.siteUrl.indexOf('localhost') <= -1) {
    await updateUserPoolClientCallbackUrl(
      event.params.UserPoolClientId ?? 'empty',
      event.params.cognitoPoolId ?? 'empty',
      `${event.params.siteUrl}/api/auth/callback/cognito`,
      `${event.params.siteUrl}/api/auth/signout`,
    );
  }
  await updateInviteMessageTemplate(event.params.siteUrl, event.params.cognitoPoolId);
  const cognitoUser = await createCognitoUser(
    event.params.cognitoPoolId,
    event.params.config.email,
    'Llavero1234!',
    event.params.config.phoneNumber,
    event.params.config.region,
  );
  if (!cognitoUser) throw new Error('Cognito user not created');
  console.log('Cognito user created: ', cognitoUser);
  const email = cognitoUser?.Attributes?.find((x) => x.Name === 'email')?.Value as string;
  const userId = cognitoUser?.Attributes?.find((x) => x.Name === 'sub')?.Value as string;
  console.log('email y sub ', email, userId);
  let user = await userRepo.getUser(email);
  console.log('user: ', user);
  let newUser;
  if (!user) {
    console.log('Creating new user');
    newUser = await userRepo.createUser({
      username: email,
      mail: email,
      name: email,
      userId: userId,
    });
    console.log('New user created: ', newUser.username);
  }
  user = user || newUser;
  if (!user) throw new Error('User not found');

  const keys = new Array<KmsKey>();
  const keysInfo = event.params.keys;
  console.log('keysInfo: ', keysInfo);
  const keyClient = new KMSClient({ region: event.params.config.region });
  const provider = new JsonRpcProvider(
    EIP155_MAINNET_CHAINS['eip155:1'].rpc || 'https://eth.llamarpc.com',
  ); //TODO get from an endpoint
  try {
    await provider._detectNetwork();
  } catch (err) {
    console.log('-----mainmainmain-----');
    console.log(err);
    provider.destroy();
  }
  for (const keyInfo of keysInfo) {
    const keyId = await keyInfo.keyId;
    const keyArn = await keyInfo.keyArn;
    const signer = new AwsKmsSigner(keyId, keyClient, provider);
    const addr = await signer.getAddress();
    console.log('addr for keyArn: ', addr, keyArn);
    keys.push({
      keyArn,
      address: addr,
      name: `key-${keyId.split('/').pop()}`,
      username: user?.username,
    });
  }
  if (keys.length <= 0) throw new Error('No keys found');

  await userRepo.createKeys(keys, user.username);
}

async function createCognitoUser(
  cognitoPoolId: string,
  email: string,
  password: string,
  phone: string,
  region: string,
): Promise<UserType | undefined> {
  console.log('Getting cognito user: ', email);
  const client = new CognitoIdentityProviderClient({ region: region });
  const cognitoUsername = await getCognitoUser(cognitoPoolId, client, email); //TODO is not getting de user error
  if (cognitoUsername) return cognitoUsername;
  console.log('Creating cognito user: ', email);
  const command = new AdminCreateUserCommand({
    UserPoolId: cognitoPoolId,
    Username: email,
    DesiredDeliveryMediums: ['EMAIL'],
    UserAttributes: [
      {
        Name: 'email',
        Value: email,
      },
      {
        Name: 'email_verified',
        Value: 'true',
      },
    ],
  });

  const response = await client.send(command);
  return response.User;
}

async function getCognitoUser(
  cognitoPoolId: string,
  client: CognitoIdentityProviderClient,
  email: string,
) {
  try {
    const command = new ListUsersCommand({
      UserPoolId: cognitoPoolId,
      Filter: `email = "${email}"`,
    });
    const response = await client.send(command);
    const users = response.Users;
    if (users && users.length > 0) {
      return users[0];
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function updateParameterStoreValue(
  name: string,
  value: string,
  region: string,
): Promise<void> {
  const ssmClient = new SSMClient({ region: region });
  const command = new PutParameterCommand({
    Name: name,
    Value: value,
    Overwrite: true,
    Type: 'String',
  });

  try {
    await ssmClient.send(command);
    console.log(`Successfully updated parameter ${name}`);
  } catch (error) {
    console.error(`Error updating parameter ${name}: ${error}`);
    throw error;
  }
}
