import { AUTH_OPTIONS } from '@/shared/utils/auth';
import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import createLogger from '@/shared/utils/logger';
import { addActivity } from '../../services/activity';
const logger = createLogger('account-endpoint');

export async function POST(request: NextRequest, { params }: { params: { address: string } }) {
  try {
    const session = await getServerSession(AUTH_OPTIONS);
    if (!session?.user?.email)
      return NextResponse.json({ message: 'Not authorized' }, { status: 401 });

    const { address } = params || {};
    const body: { address: string; chainId: string; data: string; txHash: string } =
      await request.json();
    const { chainId, data, txHash } = body || {};

    return NextResponse.json(
      await addActivity(session?.user?.email, {
        address,
        chainId,
        txHash,
        data: JSON.stringify(data),
      }),
    );
  } catch (error) {
    logger.error(error);
    return NextResponse.error();
  }
}
