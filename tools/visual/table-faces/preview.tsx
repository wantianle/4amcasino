import React from 'react';
import { createRoot } from 'react-dom/client';
import { cardFromName } from '@4am/shared';
import { PlayingCard } from '../../../apps/web/src/entities/card/PlayingCard';
import '../../../apps/web/src/app/index.css';
import './preview.css';

const faces = ['gg-four-color', 'gg-solid', 'classic-large', 'jumbo-accessible', 'minimal'] as const;
const backs = ['wine-lattice', 'black-gold', 'classic-red-blue', 'geometry', 'deep-blue-silver'] as const;
const faceCard = (face: (typeof faces)[number], size: 'pod' | 'board', name: string) => <PlayingCard card={cardFromName(name)} size={size} cardFace={face} cardBackStyle="crimson" podFace={size === 'pod'} />;
const backCard = (back: (typeof backs)[number], size: 'pod' | 'board') => <PlayingCard faceDown size={size} cardBackStyle={back} />;
const Cell = ({ children, label }: { children: React.ReactNode; label: string }) => <div className="sample">{children}<span>{label}</span></div>;

function Gallery() {
  return <main id="card-preset-gallery"><h1>4AM card face & back presets</h1>
    {(['pod', 'board'] as const).map((size) => <section key={size}><h2>Face · {size} · real Q♣</h2><div className="row">{faces.map((face) => <Cell key={face} label={`${face} · ${size}`}>{faceCard(face, size, 'Qc')}</Cell>)}</div></section>)}
    <section><h2>Court proof · real J / Q / K · exact two-way halves</h2><div className="row">{(['Jc', 'Qc', 'Kc'] as const).map((name) => <Cell key={name} label={`${name} · two-way`}>{faceCard('classic-large', 'board', name)}</Cell>)}</div></section>
    <section><h2>Back · pod + board · pod-specific selector</h2><div className="row">{backs.map((back) => <Cell key={back} label={back}><div className="back-pair">{backCard(back, 'pod')}{backCard(back, 'board')}</div></Cell>)}</div></section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Gallery />);
