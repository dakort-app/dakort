// Made at build time by the icons plugin in vite.config.ts.
declare module 'virtual:icons' {
  type Icon = { body: string; box: string } // box: the SVG viewBox
  export const fileIcons: Record<string, Icon>
  export const brandIcons: { claude: Icon; openai: Icon }
}
