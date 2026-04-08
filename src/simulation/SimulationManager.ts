import type { LLMProvider } from "../llm/types";
import type { ToolRegistry } from "../tools/ToolRegistry";
import type { SimulationEvent, SimulationMode } from "./types";
import { PersonaManager } from "./Persona";
import { ScenarioManager } from "./Scenario";
import { SimulationRunner } from "./SimulationRunner";
import { installTemplatesIfEmpty } from "./TemplateInstaller";

export interface SimulationManagerOptions {
  llmProvider: LLMProvider;
  toolRegistry?: ToolRegistry;
}

export interface ActiveSimulation {
  simId: string;
  runner: SimulationRunner;
  scenarioName: string;
  personaNames: string[];
  startedAt: number;
}

/**
 * 管理活跃的 simulation 实例。
 * 一次只允许一个 simulation 运行（资源密集型）。
 */
export class SimulationManager {
  private llmProvider: LLMProvider;
  private toolRegistry?: ToolRegistry;
  private personaManager: PersonaManager;
  private scenarioManager: ScenarioManager;
  private active: ActiveSimulation | null = null;

  constructor(options: SimulationManagerOptions) {
    this.llmProvider = options.llmProvider;
    this.toolRegistry = options.toolRegistry;
    this.personaManager = new PersonaManager();
    this.scenarioManager = new ScenarioManager();
  }

  async initialize(): Promise<void> {
    // 首次启动时安装内置模板
    await installTemplatesIfEmpty();
    await this.personaManager.initialize();
    await this.scenarioManager.initialize();
  }

  // ----------------------------------------------------------
  // 查询接口
  // ----------------------------------------------------------

  listPersonas(): Array<{ name: string; role: string; emoji: string; content: string }> {
    return this.personaManager.list().map((p) => ({
      name: p.name,
      role: p.role,
      emoji: p.emoji,
      content: p.rawContent,
    }));
  }

  listScenarios(): Array<{ name: string; description: string; mode: SimulationMode; personas?: { required: string[]; optional: string[]; max?: number }; content: string }> {
    return this.scenarioManager.list().map((s) => ({
      name: s.name,
      description: s.description,
      mode: s.mode,
      personas: s.personas,
      content: s.rawContent,
    }));
  }

  getActive(): ActiveSimulation | null {
    return this.active;
  }

  // ----------------------------------------------------------
  // Persona 管理
  // ----------------------------------------------------------

  async updatePersona(name: string, content: string): Promise<void> {
    const existing = this.personaManager.get(name);
    if (existing) {
      await this.personaManager.update(name, content);
    } else {
      await this.personaManager.create(content);
    }
  }

  // ----------------------------------------------------------
  // Scenario 管理
  // ----------------------------------------------------------

  async updateScenario(name: string, content: string): Promise<void> {
    const existing = this.scenarioManager.get(name);
    if (existing) {
      await this.scenarioManager.update(name, content);
    } else {
      await this.scenarioManager.create(content);
    }
  }

  /** 获取 LLMProvider，供 Gateway 调用用于 AI 生成 */
  getLLMProvider(): LLMProvider {
    return this.llmProvider;
  }

  // ----------------------------------------------------------
  // Simulation 生命周期
  // ----------------------------------------------------------

  /**
   * 启动一个新的 simulation。
   * 返回 AsyncGenerator，调用方需消费事件。
   */
  start(
    scenarioName: string,
    personaNames: string[],
    options?: { rounds?: number; mode?: SimulationMode },
  ): { simId: string; events: AsyncGenerator<SimulationEvent> } {
    if (this.active) {
      throw new Error(
        `A simulation is already running (${this.active.simId}). Stop it first.`,
      );
    }

    const scenario = this.scenarioManager.get(scenarioName);
    if (!scenario) {
      throw new Error(`Scenario not found: ${scenarioName}`);
    }

    // 校验 required personas 文件都存在
    if (scenario.personas?.required) {
      const missing = scenario.personas.required.filter(
        (name) => !this.personaManager.get(name),
      );
      if (missing.length > 0) {
        throw new Error(
          `Required persona(s) not found: ${missing.join(", ")}. Please create them before starting this scenario.`,
        );
      }
    }

    const personas = personaNames.map((name) => {
      const p = this.personaManager.get(name);
      if (!p) {
        throw new Error(`Persona not found: ${name}`);
      }
      return p;
    });

    // 覆盖 rounds 和 mode（如果提供）
    const adjustedScenario = { ...scenario };
    if (options?.rounds !== undefined) {
      adjustedScenario.rounds = options.rounds;
    }
    if (options?.mode !== undefined) {
      adjustedScenario.mode = options.mode;
    }

    const runner = new SimulationRunner(
      adjustedScenario,
      personas,
      this.llmProvider,
      this.toolRegistry,
    );

    const simId = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    this.active = {
      simId,
      runner,
      scenarioName,
      personaNames,
      startedAt: Date.now(),
    };

    const self = this;

    // 包装 generator，在结束时清理 active 状态
    async function* wrappedEvents(): AsyncGenerator<SimulationEvent> {
      try {
        for await (const event of runner.run()) {
          yield event;
        }
      } finally {
        if (self.active?.simId === simId) {
          self.active = null;
        }
      }
    }

    return { simId, events: wrappedEvents() };
  }

  inject(simId: string, content: string): boolean {
    if (!this.active || this.active.simId !== simId) {
      return false;
    }
    this.active.runner.inject(content);
    return true;
  }

  pause(simId: string): boolean {
    if (!this.active || this.active.simId !== simId) {
      return false;
    }
    this.active.runner.pause();
    return true;
  }

  resume(simId: string): boolean {
    if (!this.active || this.active.simId !== simId) {
      return false;
    }
    this.active.runner.resume();
    return true;
  }

  stop(simId: string): boolean {
    if (!this.active || this.active.simId !== simId) {
      return false;
    }
    this.active.runner.stop();
    // active 会在 generator 结束时自动清理
    return true;
  }

  nextRound(simId: string): boolean {
    if (!this.active || this.active.simId !== simId) {
      return false;
    }
    this.active.runner.nextRound();
    return true;
  }

  speakThenNextRound(simId: string, message: string): boolean {
    if (!this.active || this.active.simId !== simId) {
      return false;
    }
    this.active.runner.speakThenNextRound(message);
    return true;
  }

  endSimulation(simId: string): boolean {
    if (!this.active || this.active.simId !== simId) {
      return false;
    }
    this.active.runner.endSimulation();
    return true;
  }
}
