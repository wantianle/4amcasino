import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { RoundTable } from '../../../apps/web/src/widgets/table/RoundTable';
import type { SeatView } from '../../../apps/web/src/entities/table/tableTypes';
import { PlayingCard } from '../../../apps/web/src/entities/card/PlayingCard';
import '../../../apps/web/src/app/index.css';
import './preview.css';

const names = ['You', 'Mika', 'Theo', 'Jun', 'Nora', 'Alex', 'Iris', 'Leo', 'Sam'];
const seats: SeatView[] = names.map((displayName, seat) => ({
  seat, userId: seat + 1, displayName, avatarVersion: 0, stack: 2480 + seat * 125,
  isButton: seat === 7, isToAct: seat === 0, folded: seat === 3,
  allIn: false, inHand: true, broke: false, sittingOut: false,
  isLeader: seat === 8, connected: true, speaking: false, voiceMuted: false,
  won: false, wonAmount: 0, pendingBuy: 0,
}));

function Preview() {
  const [skin, setSkin] = useState(new URLSearchParams(location.search).get('skin') || 'gg-green');
  const narrow = matchMedia('(max-width: 640px)').matches;
  return <main className="table-app-bg skin-preview" data-table-skin={skin === 'default' ? undefined : skin}>
    <header className="preview-header">
      <div><p className="preview-eyebrow">4AM / MATERIAL STUDIES</p><h1>After hours.</h1></div>
      <label>Table finish<select aria-label="Table finish" value={skin} onChange={e => setSkin(e.target.value)}>
        <option value="default">Default · no attribute</option>
        <option value="gg-green">01 / GG Green</option><option value="sapphire">02 / Sapphire</option>
        <option value="burgundy">03 / Burgundy</option><option value="classic-casino">04 / Classic Casino</option>
      </select></label>
    </header>
    <div className="preview-meta"><span>NO LIMIT HOLD’EM</span><span>9 PLAYERS · 10 / 20</span></div>
    <section className="preview-stage" aria-label="Nine player table">
      <RoundTable seats={seats} mySeat={0} myUserId={1} myCards={[48, 49]}
        committedBySeat={{0: 40, 1: 80, 2: 80, 4: 80}} handId="skin-preview"
        urgent={false} handLive canSit={false} onSit={() => {}} canKick={false} onKick={() => {}}
        bankerId={2} coBankerId={null} bb={20} sb={10} narrow={narrow} centerBudget>
        <div className="preview-pot">POT <strong>1,240</strong></div>
        <div className="flex gap-1.5">{[8, 30, 44, 17, 3].map(card => <PlayingCard key={card} card={card} size={narrow ? 'sm' : 'md'} />)}</div>
      </RoundTable>
    </section>
    <footer className="preview-footer"><div><span>YOUR TURN</span><p>Call 40 to stay in the hand</p></div>
      <div className="preview-actions"><button>Fold</button><button>Call 40</button><button className="preview-raise">Raise to 160</button></div>
    </footer>
    <p className="preview-note">Surface-only preview · production seats and cards · controls are illustrative</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Preview /></BrowserRouter>);
