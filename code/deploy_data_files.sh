# Data files published next to the site, relative to the project root.
# Sourced by gh_deploy_site, gh_deploy_data, aws_deploy_site and aws_deploy_data.
# Files that do not exist locally are skipped (e.g. qrz_qso_table.tsv on the CI
# runner, which has no QRZ Logbook key); whatever is already deployed is kept.
DATA_FILES=(
    data_output/lotw_contacts.json
    data_output/qrz_cache.json
    data_output/qrz_qso_table.tsv
    data_reference/dxcc_entities.json
    data_reference/dxcc_map.geojson
    data_reference/cq_zones.geojson
    data_reference/itu_zones.geojson
)
