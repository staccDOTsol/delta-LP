import React from 'react';
import { createRoot } from 'react-dom/client';
import { Waitlist } from './Waitlist.tsx';
import { Strategies } from './Strategies.tsx';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/manrope/latin-800.css';
import './waitlist.css';
import './strategies.css';

const oilPage=location.pathname === '/oil' || location.hash.startsWith('#verify=') || new URLSearchParams(location.search).has('ref');
const MemberOperator=React.lazy(()=>import('./MemberOperator.js').then(module=>({default:module.MemberOperator})));
createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.pathname==='/operator'?<React.Suspense fallback={<p>Loading account setup…</p>}><MemberOperator/></React.Suspense>:oilPage ? <Waitlist/> : <Strategies/>}</React.StrictMode>);
