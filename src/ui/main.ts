/** 应用入口：页签切换阵型编辑页与对战沙盘页 */
import { EditorPage } from './editor';
import { SandboxPage } from './sandbox';
import './styles.css';

const editorRoot = document.querySelector<HTMLElement>('#page-editor')!;
const sandboxRoot = document.querySelector<HTMLElement>('#page-sandbox')!;

const editor = new EditorPage(editorRoot);
const sandbox = new SandboxPage(sandboxRoot);

editor.mount();
sandbox.mount();

document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    editorRoot.classList.toggle('active', tab === 'editor');
    sandboxRoot.classList.toggle('active', tab === 'sandbox');
  });
});
