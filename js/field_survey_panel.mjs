// Presentation only: folding the panel never changes the active GPS survey.
export function createFieldSurveyPanel(document) {
  const panel = document.querySelector('#fieldSurveyPanel');
  const handle = document.querySelector('#fieldSurveyHandle');
  const content = document.querySelector('#fieldSurveyContent');
  const primary = document.querySelector('#fieldSurveyPrimary');
  const extra = document.querySelector('#fieldSurveyExtra');
  const toolbar = document.querySelector('#toolbar');
  const anchor = document.createComment('Normal drawing toolbar position');
  toolbar.before(anchor);
  let collapsed = false, toolsOpen = false, drag = null, suppressClick = false;

  function measure() {
    const mode = document.querySelector('#modeSwitch').getBoundingClientRect();
    document.body.style.setProperty('--field-mode-width', `${Math.ceil(mode.width)}px`);
    const layers = document.querySelector('#layersButton').getBoundingClientRect();
    document.body.style.setProperty('--field-nav-top', `${Math.ceil(layers.bottom + 8)}px`);
    const rect = panel.getBoundingClientRect();
    document.body.style.setProperty('--field-panel-offset', `${panel.hidden ? 0 : Math.ceil(innerHeight - rect.top + 8)}px`);
  }
  function setCollapsed(value) {
    collapsed = Boolean(value);
    if (collapsed && content.contains(document.activeElement)) handle.focus();
    content.hidden = collapsed;
    panel.classList.toggle('is-collapsed', collapsed);
    handle.setAttribute('aria-expanded', String(!collapsed));
    handle.setAttribute('aria-label', collapsed ? 'Visa fältverktyg. Dra upp eller tryck.' : 'Minimera fältverktyg. Dra ned eller tryck.');
    document.querySelector('#fieldSurveyChevron').textContent = collapsed ? '⌃' : '⌄';
    measure();
  }
  function showTools(value) {
    toolsOpen = Boolean(value);
    primary.hidden = toolsOpen;
    extra.hidden = !toolsOpen;
    document.body.classList.toggle('field-survey-tools-open', toolsOpen);
    document.querySelector('#fieldMoreTools').setAttribute('aria-expanded', String(toolsOpen));
    if (toolsOpen) extra.append(toolbar);
    else anchor.after(toolbar);
    setCollapsed(false);
    content.scrollTop = 0;
    if (toolsOpen) document.querySelector('#fieldToolsBack').focus({preventScroll:true});
  }
  handle.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
    setCollapsed(!collapsed);
  });
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    drag = {id:event.pointerId, y:event.clientY, collapsed};
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const distance = event.clientY - drag.y;
    if (Math.abs(distance) > 8) suppressClick = true;
    if (!drag.collapsed) panel.style.transform = `translateY(${Math.max(0, Math.min(content.offsetHeight, distance))}px)`;
  });
  function finishDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const distance = event.clientY - drag.y;
    const next = event.type === 'pointercancel' ? drag.collapsed : Math.abs(distance) > 28 ? distance > 0 : drag.collapsed;
    drag = null;
    panel.style.transform = '';
    setCollapsed(next);
  }
  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);
  handle.addEventListener('lostpointercapture', () => { drag = null; panel.style.transform = ''; });
  document.querySelector('#fieldToolsBack').onclick = () => { showTools(false); document.querySelector('#fieldMoreTools').focus(); };
  const observer = new ResizeObserver(measure);
  observer.observe(panel);
  observer.observe(document.querySelector('#layersButton'));
  observer.observe(document.querySelector('#modeSwitch'));
  window.addEventListener('resize', measure);
  setCollapsed(false);
  return {
    toggle: () => setCollapsed(!collapsed),
    showTools,
    reset: () => showTools(false),
    get toolsOpen() { return toolsOpen; }
  };
}
