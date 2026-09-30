const { app } = require('electron');
const path = require('path');
const root = path.join(__dirname, '..');
const { createOpenXmlHelperService } = require(path.join(root, 'electron/services/openXmlHelperService.cjs'));
const { initLocalImageRenderService } = require(path.join(root, 'electron/services/localImageRenderService.cjs'));

app.whenReady().then(async () => {
  try {
    initLocalImageRenderService({ configStore: { load: () => ({}), save: () => true } });
    const svc = createOpenXmlHelperService({ app, configStore: { load: () => ({}), save: () => true } });
    const html = '<!DOCTYPE html><html><body><h1>样张</h1><p>测试段落</p><table><caption>表1</caption><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>';
    const result = await svc.renderRestrictedHtmlDocx(html, {
      template_name: 't',
      page: { paper_size: 'a4', orientation: 'portrait', margin_left_cm: 2, margin_right_cm: 2, margin_top_cm: 2, margin_bottom_cm: 2 },
    });
    console.log('RENDER_OK', result.key.slice(0, 8), 'bytes', result.bytes.length, 'roles', (result.roles || []).length);
    await svc.close();
  } catch (e) {
    console.error('RENDER_FAIL', e && e.message);
  } finally {
    app.exit(0);
  }
});
