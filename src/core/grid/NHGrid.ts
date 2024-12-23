import proj4 from 'proj4'
import { BoundingBox2D } from '../util/boundingBox2D'
import { MercatorCoordinate } from '../math/mercatorCoordinate'
import { DbAction } from '../database/db'

export const EDGE_CODE_NORTH   = 0b00
export const EDGE_CODE_WEST    = 0b01
export const EDGE_CODE_SOUTH   = 0b10
export const EDGE_CODE_EAST    = 0b11
export const EDGE_CODE_INVALID = -1

export type EDGE_CODE = typeof EDGE_CODE_NORTH | typeof EDGE_CODE_WEST | typeof EDGE_CODE_SOUTH | typeof EDGE_CODE_EAST

export interface GridNodeRenderInfo {
    uuId: string
    vertices: Float32Array
}

export interface GridNodeRenderInfoPack {
    uuIds: string[]
    vertexBuffer: Float32Array
}

export interface GridEdgeSerializedInfo {
    edgeCode: number
    adjGrids: [ string, string ]
    minPercent: [ number, number ]
    maxPercent: [ number, number ]
}

export interface GridNodeSerializedInfo {
    xMinPercent: [ number, number ]
    yMinPercent: [ number, number ]
    xMaxPercent: [ number, number ]
    yMaxPercent: [ number, number ]
}

export interface GridNodeParams {
    localId: number,
    globalId: number,
    parent?: GridNode,
    globalRange?: [ number, number ]
}

export type SubdivideRules = {

    srcCS: string
    targetCS: string
    bBox: BoundingBox2D
    rules: [ number, number ][]
}

/*
   ----- 0b00 -----
  |                |
  0b01   Grid    0b11
  |                |
   ----- 0b10 ----- 
*/
export class GridEdge {

    key: string
    properties: { [ key:string ]: any }

    constructor(key: string, properties: string[] | undefined) {

        this.key = key
        this.properties = {}

        if (properties) {
            for (const key of properties) 
                this.properties[key] = undefined
        }
    }

    private _getKeyArray(): (number | 'null')[] {

        return this.key.split('-').map(value => {
            return value === 'null' ? 'null' : Number(value)
        })
    }

    static createKey(grid1: GridNode | null, grid2: GridNode | null, edgeCode: number, range: [ number, number, number, number ]): string {

        const key1 = grid1 ? `${grid1.level}-${grid1.globalId}` : 'null-null'
        const key2 = grid2 ? `-${grid2.level}-${grid2.globalId}` : '-null-null'
        const key3 = `-${range[0]}-${range[1]}-${range[2]}-${range[3]}`
        const key4 = `-${edgeCode}`

        return key1 + key2 + key3 + key4
    }

    get opKey(): string {
        return GridEdge.getOpKey(this.key)
    }

    get serialization(): GridEdgeSerializedInfo {
        
        const keyArray = this._getKeyArray()

        return {
            adjGrids: [ 
                [ keyArray[0], keyArray[1] ].join('-'), // [ grid1 ] level-globalId
                [ keyArray[2], keyArray[3] ].join('-')  // [ grid2 ] level-globalId
            ],
            minPercent: [ keyArray[4] as number, keyArray[5] as number ],
            maxPercent: [ keyArray[6] as number, keyArray[7] as number ],
            edgeCode: keyArray[8] as number
        }
    }

    static getToggleEdgeCode(code: number): EDGE_CODE | typeof EDGE_CODE_INVALID {

        switch (code) {
            case EDGE_CODE_NORTH:
                return EDGE_CODE_SOUTH

            case EDGE_CODE_WEST:
                return EDGE_CODE_EAST

            case EDGE_CODE_SOUTH:
                return EDGE_CODE_NORTH

            case EDGE_CODE_EAST:
                return EDGE_CODE_WEST
            default:
                console.error('Provided edge code is invalid.')
                return EDGE_CODE_INVALID
        }
    }

    static getOpKey(key: string): string {

        const keyArray = key.split('-').map((value, index) => {
            if (index === 8) {
                return GridEdge.getToggleEdgeCode(Number(value));
            }
            return value === 'null' ? 'null' : Number(value);
        })

        const opKeyArray = keyArray.slice()
        opKeyArray[0] = keyArray[2]
        opKeyArray[1] = keyArray[3]
        opKeyArray[2] = keyArray[0]
        opKeyArray[3] = keyArray[1]

        return opKeyArray.join('-')
    }
}

export class GridNodeRecord {

    isActivated = false
    children_uuIds: Array<string> = []
    edge_uuIds = new Array<Set<string>>(4)
    neighbour_uuIds = new Array<Set<string>>(4)

    constructor(public uuId: string) {}

    static async createFromIndexedDB(dbManager: (dbName: string, actions: DbAction[]) => Promise<any[]>, key: any): Promise<GridNodeRecord> {

        const readNodeAction: DbAction = {
            storeName: 'GridNode',
            type: 'R',
            data: key
        }

        const gridRecord = new GridNodeRecord(key) as any
        const storedData = (await dbManager('GridDB', [ readNodeAction ]))[0]
        for (const _key in storedData) {
            gridRecord[_key] = storedData[_key]
        }

        return gridRecord as GridNodeRecord
    }

    get level(): number {
        return +this.uuId.split('-')[0]
    }

    get globalId(): number {
        return +this.uuId.split('-')[1]
    }

    get keys(): [ level: number, globalId: number ] {
        return this.uuId.split('-').map(key => +key) as [ level: number, globalId: number ]
    }
}

export class GridNode {

    uuId: string
    localId: number
    globalId: number

    xMinPercent: [ number, number ]
    xMaxPercent: [ number, number ]
    yMinPercent: [ number, number ]
    yMaxPercent: [ number, number ]
    
    level: number
    children: Array<string | null>
    edges: [ Set<string>, Set<string>, Set<string>, Set<string> ]
    neighbours: [ Set<string>, Set<string>, Set<string>, Set<string> ]

    hit: boolean
    edgeCalculated: boolean

    constructor(options: GridNodeParams) {

        this.hit = false
        this.edgeCalculated = false

        this.localId = options.localId
        this.globalId = options.globalId
        this.level = options.parent !== undefined ? options.parent.level + 1 : 0
        this.uuId = `${this.level}-${this.globalId}`

        this.children = []

        // Division Coordinates [ numerator, denominator ] 
        // Use integer numerators and denominators to avoid coordinate precision issue
        this.xMinPercent = [ 0, 1 ]
        this.xMaxPercent = [ 1, 1 ]
        this.yMinPercent = [ 0, 1 ]
        this.yMaxPercent = [ 1, 1 ]
        
        this.neighbours = [ 
            new Set<string>(),
            new Set<string>(),
            new Set<string>(),
            new Set<string>()
        ]

        this.edges = [
            new Set<string>(),
            new Set<string>(),
            new Set<string>(),
            new Set<string>()
        ]

        // Update division coordinates if globalRange provided
        if (options.globalRange) {

            const [ width, height ] = options.globalRange
            const globalU = this.globalId % width
            const globalV = Math.floor(this.globalId / width)

            this.xMinPercent = simplifyFraction(globalU, width)
            this.xMaxPercent = simplifyFraction(globalU + 1, width)
            this.yMinPercent = simplifyFraction(globalV, height)
            this.yMaxPercent = simplifyFraction(globalV + 1, height)
        }
    }

    get xMin(): number {

        return this.xMinPercent[0] / this.xMinPercent[1]
    }

    get xMax(): number {

        return this.xMaxPercent[0] / this.xMaxPercent[1]
    }

    get yMin(): number {

        return this.yMinPercent[0] / this.yMinPercent[1]
    }

    get yMax(): number {

        return this.yMaxPercent[0] / this.yMaxPercent[1]
    }

    resetEdges(): void {

        this.edgeCalculated = false
        this.edges.forEach(edge => edge.clear())
    }

    addEdge(edge: GridEdge, edgeCode: number): void {

        if (!this.edges[edgeCode].has(edge.key) && !this.edges[edgeCode].has(edge.opKey)){
            this.edges[edgeCode].add(edge.key)
        }
    }

    get edgeKeys(): string[] {

        return [
            ...this.edges[EDGE_CODE_NORTH],
            ...this.edges[EDGE_CODE_WEST],
            ...this.edges[EDGE_CODE_SOUTH],
            ...this.edges[EDGE_CODE_EAST]
        ]
    }

    get serialization() {

        return {
            xMinPercent: this.xMinPercent,
            yMinPercent: this.yMinPercent,
            xMaxPercent: this.xMaxPercent,
            yMaxPercent: this.yMaxPercent
        }
    }

    getVertices(converter: proj4.Converter, bBox: BoundingBox2D) {

        const xMin = lerp(bBox.xMin, bBox.xMax, this.xMin)
        const yMin = lerp(bBox.yMin, bBox.yMax, this.yMin)
        const xMax = lerp(bBox.xMin, bBox.xMax, this.xMax)
        const yMax = lerp(bBox.yMin, bBox.yMax, this.yMax)
        
        const targetTL = converter.forward([ xMin, yMax ])  // srcTL
        const targetTR = converter.forward([ xMax, yMax ])  // srcTR
        const targetBL = converter.forward([ xMin, yMin ])  // srcBL
        const targetBR = converter.forward([ xMax, yMin ])  // srcBR

        const renderTL = MercatorCoordinate.fromLonLat(targetTL as [ number, number ])
        const renderTR = MercatorCoordinate.fromLonLat(targetTR as [ number, number ])
        const renderBL = MercatorCoordinate.fromLonLat(targetBL as [ number, number ])
        const renderBR = MercatorCoordinate.fromLonLat(targetBR as [ number, number ])

        return new Float32Array([
            ...renderTL, ...renderTR,
            ...renderBL, ...renderBR
        ])
    }

    release(): null {

        this.xMinPercent = [ 0, 0 ]
        this.xMaxPercent = [ 0, 0 ]
        this.yMinPercent = [ 0, 0 ]
        this.yMaxPercent = [ 0, 0 ]

        this.edges.forEach(edgeSet => edgeSet.clear())
        // this.neighbours.forEach((gridSet, edgeCode) => {
        //     gridSet.forEach(grid => {
        //         const opEdge = GridEdge.getToggleEdgeCode(edgeCode) as EDGE_CODE
        //         grid.neighbours[opEdge].delete(this)
        //     })
        // })

        this.children = []

        this.uuId = ''
        this.globalId = -1
        this.localId = -1
        this.level = -1

        this.edgeCalculated = false
        this.hit = false

        return null
    }
    
    equal(grid: GridNode): boolean {

        return (this.level === grid.level) && (this.globalId === grid.globalId)
    }
    
    within(bBox: BoundingBox2D, lon: number, lat: number): boolean {

        const xMin = lerp(bBox.xMin, bBox.xMax, this.xMin)
        const yMin = lerp(bBox.yMin, bBox.yMax, this.yMin)
        const xMax = lerp(bBox.xMin, bBox.xMax, this.xMax)
        const yMax = lerp(bBox.yMin, bBox.yMax, this.yMax) 

        if (lon < xMin || lat < yMin || lon > xMax || lat > yMax) return false
        return true
    }
}

export class Grid {

    
}

// Helpers //////////////////////////////////////////////////////////////////////////////////////////////////////

function lerp(a: number, b: number, t: number): number {
    return (1.0 - t) * a + t * b
}

function gcd(a: number, b: number): number {

    while (b !== 0) {
        const temp = b
        b = a % b
        a = temp
    }
    
    return a
}
  
function simplifyFraction(n: number, m: number): [ number, number ] {

    const divisor = gcd(n, m)
    return [ n / divisor, m / divisor ]
}
  