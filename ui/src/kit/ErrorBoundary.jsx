import { Component } from 'react';
import { closeSheet } from '../store.js';
import { Sheet, SheetHead } from './Layout.jsx';
import { Button } from './Button.jsx';

/** A sheet that cannot render (most often: the desk was updated and this tab asks for a replaced chunk) offers a
 *  reload instead of a blank screen. Ticket drafts are kept in local storage, so a reload loses nothing typed there. */
export class SheetBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(prev) { if (prev.sheetKey !== this.props.sheetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    const stale = /dynamically imported module|Failed to fetch|Importing a module script failed|chunk/i.test(String(this.state.error?.message));
    return (
      <Sheet label="Could not open" onClose={closeSheet} head={<SheetHead title={stale ? 'The desk was updated' : 'This panel could not open'} onClose={closeSheet} />}
        footer={<div className="f-actions"><span className="spacer" /><Button variant="primary" onClick={() => location.reload()}>Reload the desk</Button></div>}>
        <p>{stale ? 'A newer version of the desk is running. Reload to continue; drafts in ticket replies are kept.' : `Error: ${this.state.error?.message || 'unknown'}. Reload, or open the Classic view.`}</p>
        <p><a href="/classic.html">Open the Classic view</a></p>
      </Sheet>
    );
  }
}
