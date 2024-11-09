import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

export interface KMSKeyProps {
  alias?: string;
  description?: string;
}

export class KMSKey extends pulumi.ComponentResource {
  public readonly key: aws.kms.Key;
  public readonly keyId: pulumi.Output<string>;
  public readonly keyArn: pulumi.Output<string>;

  constructor(name: string, props: KMSKeyProps, opts?: pulumi.ComponentResourceOptions) {
    super('llavero:kms:Key', name, {}, opts);

    this.key = new aws.kms.Key(name, {
      customerMasterKeySpec: 'ECC_SECG_P256K1',
      keyUsage: 'SIGN_VERIFY',
      deletionWindowInDays: 7,
      description: props.description,
      enableKeyRotation: false,
    });

    if (props.alias) {
      new aws.kms.Alias(`${name}-alias`, {
        name: `alias/${props.alias}`,
        targetKeyId: this.key.id,
      });
    }

    this.keyId = this.key.id;
    this.keyArn = this.key.arn;
  }
}
