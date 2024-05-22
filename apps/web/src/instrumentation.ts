import { getParameterValue } from '@/shared/utils/aws';
import createLogger from '@/shared/utils/logger';
const logger = createLogger('Instrumentation');

export async function register() {
  // @ts-expect-error 🚧 ETHERS IS BROKEN. THIS IS A WORKAROUND
  BigInt.prototype.toJSON = function () {
    return this.toString();
  };

  try {
    console.log('registering instrumentation');
    const siteUrl = await getParameterValue(
      process.env.SITEURL_PARAM_NAME ?? '/sst/llavero2wfwq/ranu/NextjsSite/Llavero/url',
    );
    process.env.NEXTAUTH_URL = siteUrl;
    process.env.NEXT_PUBLIC_SITE_URL = siteUrl;
  } catch (error) {
    console.log({ error });
    logger.error(error);
    throw new AggregateError([new Error('Error in instrumentation'), error]);
  }
}
