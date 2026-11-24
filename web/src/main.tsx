import { render } from 'preact';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import 'uplot/dist/uPlot.min.css';
import './styles/index.css';
import { initTheme } from './lib/theme';
import { App } from './app';

initTheme();
render(<App />, document.getElementById('app')!);
