// The parts of ECharts this app draws with; importing the full 'echarts' bundles every chart type.
// A chart or component missing here renders nothing and logs "[ECharts] ... not imported" in dev — add it below.
import { use } from 'echarts/core'
import { LineChart, ScatterChart, CustomChart, HeatmapChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, TitleComponent, ToolboxComponent,
  GraphicComponent, MarkLineComponent, MarkAreaComponent, BrushComponent, VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers'
import { LegacyGridContainLabel } from 'echarts/features'

use([
  LineChart, ScatterChart, CustomChart, HeatmapChart,
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, TitleComponent, ToolboxComponent,
  GraphicComponent, MarkLineComponent, MarkAreaComponent, BrushComponent, VisualMapComponent,
  CanvasRenderer, SVGRenderer, LegacyGridContainLabel,
])

export * from 'echarts/core'
export type { EChartsOption, SeriesOption } from 'echarts'
