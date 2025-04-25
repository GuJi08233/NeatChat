"use client";
import {
  ApiPath,
  IFLYTEK_BASE_URL,
  Iflytek,
  REQUEST_TIMEOUT_MS,
} from "@/app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "@/app/store";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  SpeechOptions,
} from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import { prettyObject } from "@/app/utils/format";
import { getClientConfig } from "@/app/config/client";
import { getMessageTextContent } from "@/app/utils";
import { fetch } from "@/app/utils/stream";

import { RequestPayload } from "./openai";

export class SparkApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.iflytekUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.Iflytek;
      baseUrl = isApp ? IFLYTEK_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Iflytek)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    // 检查是否有错误
    if (res.code !== 0) {
      throw new Error(`Spark API错误: ${res.message || "未知错误"} (错误码: ${res.code})`);
    }
    
    // 提取文本内容 - OpenAI兼容模式
    return res.choices?.[0]?.message?.content || "";
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions) {
    const messages: ChatOptions["messages"] = [];
    for (const v of options.messages) {
      const content = getMessageTextContent(v);
      messages.push({ role: v.role, content });
    }

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };

    // 使用OpenAI兼容格式
    const requestPayload = {
      model: modelConfig.model,
      messages: messages,
      stream: !!options.config.stream,
      user: "user", // 用户ID
      temperature: modelConfig.temperature,
      top_p: modelConfig.top_p || 0.95,
      max_tokens: Math.min(modelConfig.max_tokens || 32768, 32768),
    };

    console.log("[Request] Spark payload: ", requestPayload);

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(Iflytek.ChatPath);
      const headers = { ...getHeaders() };
      
      // 使用讯飞星火API的鉴权方式
      const accessStore = useAccessStore.getState();
      // APIpassword方式鉴权
      if (accessStore.iflytekApiKey) {
        headers["Authorization"] = `Bearer ${accessStore.iflytekApiKey}`;
      }
      
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers,
      };

      // Make a fetch request
      const requestTimeoutId = setTimeout(
        () => {
          console.log("[Spark] 请求超时，正在中止");
          controller.abort();
        },
        REQUEST_TIMEOUT_MS,
      );

      if (shouldStream) {
        let responseText = "";
        let remainText = "";
        let finished = false;
        let responseRes: Response;
        let isInThinking = false;

        // Animate response text to make it look smooth
        function animateResponseText() {
          if (finished || controller.signal.aborted) {
            responseText += remainText;
            console.log("[Response Animation] finished");
            return;
          }

          if (remainText.length > 0) {
            const fetchCount = Math.max(1, Math.round(remainText.length / 60));
            const fetchText = remainText.slice(0, fetchCount);
            responseText += fetchText;
            remainText = remainText.slice(fetchCount);
            options.onUpdate?.(responseText, fetchText);
          }

          requestAnimationFrame(animateResponseText);
        }

        // Start animation
        animateResponseText();

        const finish = () => {
          if (!finished) {
            finished = true;
            options.onFinish(responseText + remainText, responseRes);
          }
        };

        controller.signal.onabort = finish;

        fetchEventSource(chatPath, {
          fetch: fetch as any,
          ...chatPayload,
          async onopen(res) {
            clearTimeout(requestTimeoutId);
            const contentType = res.headers.get("content-type");
            console.log("[Spark] request response content type: ", contentType);
            responseRes = res;
            if (contentType?.startsWith("text/plain")) {
              responseText = await res.clone().text();
              return finish();
            }

            // Handle different error scenarios
            if (
              !res.ok ||
              !res.headers
                .get("content-type")
                ?.startsWith(EventStreamContentType) ||
              res.status !== 200
            ) {
              let extraInfo = await res.clone().text();
              try {
                const resJson = await res.clone().json();
                extraInfo = prettyObject(resJson);
              } catch {}

              if (res.status === 401) {
                extraInfo = Locale.Error.Unauthorized;
              }

              options.onError?.(
                new Error(
                  `Request failed with status ${res.status}: ${extraInfo}`,
                ),
              );
              return finish();
            }
          },
          onmessage(msg) {
            if (msg.data === "[DONE]" || finished) {
              return finish();
            }
            const text = msg.data;
            try {
              // 检查是否是空行或心跳信息
              if (!text || text.trim() === '') {
                return;
              }
              
              // 移除开头的"data:"前缀(如果有)
              let jsonText = text;
              if (text.startsWith('data:')) {
                jsonText = text.substring(5).trim();
              }
              
              const json = JSON.parse(jsonText);
              
              // 检查是否有错误
              if (json.code !== 0) {
                console.error("[Spark] API错误:", json);
                options.onError?.(new Error(`Spark API错误: ${json.message || "未知错误"} (错误码: ${json.code})`));
                return finish();
              }
              
              // 处理OpenAI兼容格式的响应
              const choices = json.choices || [];
              if (choices.length > 0) {
                const delta = choices[0].delta || {};
                
                // 处理安全审核信息
                const security_suggest = delta.security_suggest || {};
                if (security_suggest.action === "HIDE_CONTINUE") {
                  console.log("[Spark] 安全审核：隐藏内容并继续", security_suggest);
                  // 隐藏部分内容但继续响应
                  return;
                }
                
                // 仅当delta中有role且为assistant时，忽略这个消息（通常是流式开始的标记）
                if (delta.role === "assistant" && !delta.content && !delta.reasoning_content) {
                  return;
                }
                
                const content = delta.content || "";
                const reasoning = delta.reasoning_content || "";
                
                // 处理思考过程
                if (reasoning && reasoning.length > 0) {
                  if (!isInThinking) {
                    isInThinking = true;
                    remainText += "<think>\n" + reasoning;
                  } else {
                    remainText += reasoning;
                  }
                  return;
                }

                if (content && content.length > 0) {
                  // 如果正在思考并收到了非思考内容，结束思考
                  if (isInThinking) {
                    isInThinking = false;
                    remainText += "\n</think>\n\n" + content;
                  } else {
                    remainText += content;
                  }
                }
              }
              
              // 如果有usage信息且正在思考，结束思考模式
              if (json.usage && isInThinking) {
                console.log("[Spark] Usage:", json.usage);
                isInThinking = false;
                remainText += "\n</think>\n\n";
              }
              
              // 检查是否完成
              if (json.status === "complete" || json.choices?.[0]?.finish_reason) {
                console.log("[Spark] 响应完成");
                return finish();
              }
            } catch (e) {
              // 如果解析失败，可能是非JSON数据或其他特殊格式
              console.error("[Request] parse error", text);
              if (text === '[DONE]') {
                return finish();
              }
              options.onError?.(new Error(`Failed to parse response: ${text}`));
            }
          },
          onclose() {
            finish();
          },
          onerror(e) {
            options.onError?.(e);
            throw e;
          },
          openWhenHidden: true,
        });
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        if (!res.ok) {
          const errorText = await res.text();
          options.onError?.(
            new Error(`Request failed with status ${res.status}: ${errorText}`),
          );
          return;
        }

        try {
          const resJson = await res.json();
          
          // 检查是否有错误
          if (resJson.code !== 0) {
            throw new Error(`Spark API错误: ${resJson.message || "未知错误"} (错误码: ${resJson.code})`);
          }
          
          // 处理思考过程和实际内容
          let fullContent = "";
          const message = resJson.choices?.[0]?.message || {};
          const reasoning = message.reasoning_content;
          const content = message.content;
          
          // 检查是否有安全审核信息
          if (message.security_suggest?.action === "HIDE_CONTINUE") {
            console.log("[Spark] 安全审核：部分内容已隐藏", message.security_suggest);
          }
          
          if (reasoning) {
            fullContent += `<think>\n${reasoning}\n</think>\n\n`;
          }
          
          if (content) {
            fullContent += content;
          }
          
          options.onFinish(fullContent, res);
        } catch (e) {
          console.error("[Request] failed to parse response", e);
          options.onError?.(e as Error);
        }
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }

  async usage() {
    return {
      used: 0,
      total: 0,
    };
  }

  async models(): Promise<LLMModel[]> {
    return [];
  }
}
