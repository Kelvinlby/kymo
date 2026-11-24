import { render } from 'preact';
import 'uplot/dist/uPlot.min.css';
import './styles.css';
import { App } from './app';

render(<App />, document.getElementById('app')!);
