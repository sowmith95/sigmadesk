import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/desk.css';
import './styles/kit.css';
import { App } from './App.jsx';
import { start } from './store.js';

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
start();
