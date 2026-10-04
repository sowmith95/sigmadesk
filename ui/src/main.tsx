import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { start } from './store.js';

document.documentElement.classList.add('dark');
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
start();
