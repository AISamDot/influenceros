import { Empty, StubHeader } from '@/components/stub';
import { requireOwnerPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Radar' };

/** Growth Radar (stream I, docs/IOS-5-CONTRACTS.md): growing accounts, outliers, trends and remix briefs. Contract stub. */
export default async function Radar() {
  await requireOwnerPage();
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <StubHeader title="Radar" milestone="IOS-5" lead="Fast-growing accounts in our niches, outlier reels, trends adopted across accelerating accounts, and the remix briefs built from them." />
      <Empty>The Growth Radar fills this page once its first weekly scan runs.</Empty>
    </div>
  );
}
