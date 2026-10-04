import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { HubApp } from './HubApp';

document.documentElement.classList.add('dark');
createRoot(document.getElementById('root')!).render(<StrictMode><HubApp /></StrictMode>);
