export default class Weiwudi {
  constructor(mapID: string, attrs: any);

  static registerSW(
    sw: string | URL,
    swOptions: RegistrationOptions
  ): Promise<ServiceWorkerRegistration>;
  static swCheck(): Promise<boolean>;
  static registerMap(mapID: string, options: any): Promise<Weiwudi>;
  static retrieveMap(mapID: string): Promise<Weiwudi>;
  static removeMap(mapID: string): Promise<void>;

  public release(): void;
  public checkAspect(): void;

  public stats(): Promise<{
    size?: number;
    count?: number;
    total?: number;
    percent?: number;
  }>;
  public clean(): Promise<void>;
  public fetchAll(): Promise<void>;
  public remove(): Promise<void>;
  public cancel(): Promise<void>;

  public addEventListener(type: string, handler: any): void;
  public removeEventListener(type: string, handler: any): void;
}
