// 生图调度层：按当前配置的生图服务商，把「模型测试」与「正式生图」分派到对应 provider。
//
// 这些原本是 aiService.cjs 的模块级函数；搬出来后只依赖三个 provider 模块与请求工具，可单独测试。

const { getImageModelAvailability } = require('./requestUtils.cjs');
const { runComfyUIImageGeneration, generateComfyUIImage } = require('./comfyuiImage.cjs');
const { generateOpenAICompatibleImage } = require('./openaiImages.cjs');
const { generateGoogleImage } = require('./googleImages.cjs');

async function testComfyUIImageModel(app, config) {
  const testRequest = {
    title: '测试',
    prompt: '大字报，内容是"易标AI老好了"',
  };
  const { image, workflow_source: workflowSource } = await runComfyUIImageGeneration(app, config, testRequest, {
    returnRawImage: true,
    isTest: true,
    logExtra: { pendingType: 'image-test-pending', successType: 'image-test', errorType: 'image-test-error' },
  });
  const sourceLabel = workflowSource === 'custom' ? '设置中粘贴的工作流'
    : workflowSource === 'history' ? '服务器最近成功执行的工作流'
      : '按服务器已装模型自动组装的工作流';
  return {
    success: true,
    message: `测试成功：ComfyUI 已返回生成的图片（复用${sourceLabel}）`,
    image_url: '',
    image_data: image.buffer.toString('base64'),
    mime_type: image.mime_type || 'image/png',
  };
}
async function generateImageWithConfig(app, config, request) {
  const availability = getImageModelAvailability(config);
  if (!availability.available) {
    throw new Error(availability.message);
  }

  if (config.image_model?.provider === 'jinlong' || config.image_model?.provider === 'volcengine' || config.image_model?.provider === 'agnes' || config.image_model?.provider === 'custom') {
    return generateOpenAICompatibleImage(app, config, request, config.image_model.provider);
  }

  if (config.image_model?.provider === 'google-ai-studio') {
    return generateGoogleImage(app, config, request);
  }

  if (config.image_model?.provider === 'comfyui') {
    return generateComfyUIImage(app, config, request);
  }

  throw new Error('当前生图服务商暂不支持正文配图');
}

module.exports = {
  testComfyUIImageModel,
  generateImageWithConfig,
};
