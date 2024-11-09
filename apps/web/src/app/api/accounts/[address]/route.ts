import { AUTH_OPTIONS } from '@/shared/utils/auth';
import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import createLogger from '@/shared/utils/logger';
import getWallet from '../services/get-wallet';
import { updateWalletName } from '../services/update-wallet';
const logger = createLogger('account-endpoint-address');

export async function GET(request: NextRequest, { params }: { params: { address: string } }) {
  try {
    const session = await getServerSession(AUTH_OPTIONS);
    if (!session?.user?.email)
      return NextResponse.json({ message: 'Not authorized' }, { status: 401 });

    const { address } = params || {};

    return NextResponse.json(await getWallet(address, session?.user?.email));
  } catch (error) {
    logger.error(error);
    return NextResponse.error();
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { address: string } }) {
  try {
    const session = await getServerSession(AUTH_OPTIONS);
    if (!session?.user?.email)
      return NextResponse.json({ message: 'Not authorized' }, { status: 401 });

    const { address } = params || {};
    const rawBody = await request.json();

    // Type guard to ensure body has the correct shape
    if (
      !rawBody ||
      typeof rawBody !== 'object' ||
      !('name' in rawBody) ||
      typeof rawBody.name !== 'string'
    ) {
      return NextResponse.json({ message: 'Invalid request body' }, { status: 400 });
    }

    const body = rawBody as { name: string };
    const { name } = body;

    return NextResponse.json(
      await updateWalletName(address || '', session?.user?.email, {
        name: name || '',
      }),
    );
  } catch (error) {
    logger.error(error);
    return NextResponse.error();
  }
}
