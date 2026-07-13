import { AppError } from '../common';
import {
  checkPluginAiPolicy,
  type PluginAiPolicyInput,
  type PluginAiPolicyResult,
} from './plugin-ai-policy';

export function assertPluginAiPolicy(input: PluginAiPolicyInput): PluginAiPolicyResult {
  const result = checkPluginAiPolicy(input);
  if (!result.ok) {
    throw new AppError(400, 'plugin_ai_policy_failed', '插件不符合平台 AI 使用政策', result);
  }
  return result;
}
