// DSH 宿主注入的服务与事件,不在本插件的依赖树内(本插件仅依赖 @deepseek-ai/cordis
// 与 @deepseek-ai/dsh-llm;timer/tools/agent/pre-step/agent/request-error/session/event/
// session/disposed 由宿主其它包提供)。这里按使用到的表面补声明,供 tsc / VSCode 类型
// 检查;运行期由 DSH 宿主注入。
import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    timer: {
      timeout(ms: number): Promise<void>
      interval(ms: number, cb: () => void): () => void
    }
    tools: {
      register(tool: any): () => void
    }
    /** 注册 fiber 卸载回调:返回的 disposer 在插件卸载 / 宿主退出时执行。 */
    effect(execute: () => void | (() => void | Promise<void>)): () => void
  }
  interface Events {
    'agent/pre-step'(payload: any, next: () => Promise<void>): void
    // agent/request-error:请求失败后的恢复瀑布。返回 {kind:'retry'} 即请求
    // 重跑本 step(DSH 原生循环执行);返回 next() 的结果则沿用下游决定。
    'agent/request-error'(payload: any, next: () => Promise<any>): Promise<any> | void
    'session/event'(session: any, event: any): void
    // session/disposed:会话从 store 摘除时的配对收尾事件(仅对已 announced 的
    // 会话发出 ⇒ 创建回滚不触发)。这是「会话结束」的正确信号 —— 注意
    // session/end-seed 不是:它是构造期 seed 边界标记,且从不发布到 session/event。
    'session/disposed'(session: any): void
  }
}
