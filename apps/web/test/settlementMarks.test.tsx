import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  openSettlementProof,
  SettlementMarksContent,
  TransferProofDialog,
} from '../src/pages/settle/SettlePage.tsx';
import { ApiError } from '../src/shared/api.ts';
import type { SettlementMark } from '../src/shared/api.ts';
import { t } from '../src/shared/i18n/index.ts';

const mark = (over: Partial<SettlementMark> & { userId: number }): SettlementMark => ({
  name: `user-${over.userId}`,
  note: null,
  hasProof: false,
  ts: over.userId,
  ...over,
});

const my = mark({ userId: 7, name: 'Me', note: '我已转账，备注在这里', hasProof: true, ts: 1 });
const other = mark({ userId: 9, name: 'River', note: '对方确认了这笔钱', hasProof: false, ts: 2 });

describe('settlement marks', () => {
  it('renders both sides remarks and proof actions', () => {
    const markup = renderToStaticMarkup(
      <SettlementMarksContent
        myUserId={7}
        otherUserId={9}
        otherName="River"
        marks={[my, other]}
        onOpenProof={() => undefined}
      />,
    );
    expect(markup).toContain('我已转账，备注在这里');
    expect(markup).toContain('对方确认了这笔钱');
    expect(markup).toContain(t('Open transfer proof'));
    expect(markup).toContain(t('No transfer proof uploaded.'));
  });

  it('shows a translated placeholder when one side has not filled in', () => {
    const markup = renderToStaticMarkup(
      <SettlementMarksContent
        myUserId={7}
        otherUserId={9}
        otherName="River"
        marks={[my]}
        onOpenProof={() => undefined}
      />,
    );
    expect(markup).toContain(t('{name} has not filled this in yet.', { name: 'River' }));
    expect(markup).not.toContain('对方确认了这笔钱');
  });

  it('never renders or offers a third-party mark as the counterpart', () => {
    const third = mark({
      userId: 99,
      name: 'Mallory',
      note: '第三方备注 secret',
      hasProof: true,
      ts: 3,
    });
    const markup = renderToStaticMarkup(
      <SettlementMarksContent
        myUserId={7}
        otherUserId={9}
        otherName="River"
        marks={[my, third]}
        onOpenProof={() => undefined}
      />,
    );
    // The stray mark must not leak a note, a name, or an "open proof" action.
    expect(markup).not.toContain('第三方备注 secret');
    expect(markup).not.toContain('Mallory');
    expect(markup).not.toContain('user-99');
    expect(markup.match(new RegExp(t('Open transfer proof'), 'g')) ?? []).toHaveLength(1);
    // Its absence is reported as the counterpart not having filled in.
    expect(markup).toContain(t('{name} has not filled this in yet.', { name: 'River' }));
  });

  it('keeps two settlements in different rooms isolated', () => {
    const roomBOther = mark({ userId: 11, name: 'Quinn', note: 'B房间对方备注', hasProof: false, ts: 4 });
    const roomA = renderToStaticMarkup(
      <SettlementMarksContent
        myUserId={7}
        otherUserId={9}
        otherName="River"
        marks={[my, other]}
        onOpenProof={() => undefined}
      />,
    );
    const roomB = renderToStaticMarkup(
      <SettlementMarksContent
        myUserId={7}
        otherUserId={11}
        otherName="Quinn"
        marks={[my, roomBOther]}
        onOpenProof={() => undefined}
      />,
    );
    expect(roomA).toContain('对方确认了这笔钱');
    expect(roomA).not.toContain('B房间对方备注');
    expect(roomB).toContain('B房间对方备注');
    expect(roomB).not.toContain('对方确认了这笔钱');
  });
});

describe('openSettlementProof', () => {
  it('turns a fetched proof Blob into a viewable object URL', async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const result = await openSettlementProof(42, 7, async () => blob);
    expect('url' in result).toBe(true);
    if ('url' in result) {
      expect(result.url.startsWith('blob:')).toBe(true);
      URL.revokeObjectURL(result.url);
    }
  });

  it('maps a 404 to the no-proof copy', async () => {
    const result = await openSettlementProof(42, 7, async () => {
      throw new ApiError('no photo', 404);
    });
    expect(result).toEqual({ error: t('No transfer proof uploaded.') });
  });

  it('maps a 403 to the no-longer-available copy', async () => {
    const result = await openSettlementProof(42, 7, async () => {
      throw new ApiError('not your settlement', 403);
    });
    expect(result).toEqual({ error: t('This settlement is no longer available to you.') });
  });

  it('maps any other failure to the generic copy', async () => {
    const result = await openSettlementProof(42, 7, async () => {
      throw new Error('network down');
    });
    expect(result).toEqual({ error: t('The transfer proof could not be opened.') });
  });
});

describe('TransferProofDialog', () => {
  it('renders the proof image inside a labelled dialog', () => {
    const markup = renderToStaticMarkup(
      <TransferProofDialog url="blob:test-proof" onClose={() => undefined} />,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('src="blob:test-proof"');
    expect(markup).toContain(t('Transfer proof'));
  });
});
