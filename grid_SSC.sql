CREATE TABLE default.grid_SSC
(
    `gridX` UInt16 CODEC(DoubleDelta, ZSTD(1)),
    `gridY` UInt16 CODEC(DoubleDelta, ZSTD(1)),
    `longitude` Float64 CODEC(Gorilla(8), ZSTD(3)),
    `latitude` Float64 CODEC(Gorilla(8), ZSTD(3))
)
ENGINE = MergeTree
ORDER BY (longitude, latitude)
SETTINGS index_granularity = 8192
