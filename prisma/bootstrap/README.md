# Línea base para bases locales vacías

La cadena histórica no se puede reproducir desde cero: después de la migración
inicial faltan objetos previos a `20260912235900_payment_states`. Esta línea
base es una instantánea del esquema de integración hasta
`20261124120000_initial_interview`; no altera los archivos históricos.

`baseline.sql` procede de `prisma migrate diff --from-empty` y añade las cuatro
restricciones CHECK presentes en las migraciones de chat y reseñas. El script
verifica las huellas del esquema, SQL y migraciones, exige un esquema vacío,
ejecuta el SQL en una transacción y comprueba el esquema y esas restricciones.
Después registra las migraciones históricas como **incluidas en la línea base**
con `prisma migrate resolve`. No las ejecuta individualmente: su historial no
equivale a haberlas reproducido. Si cualquier paso falla después de iniciar,
use otra base desechable vacía; no aplique este procedimiento a datos existentes.

## Uso exclusivo en el entorno de pruebas local

El script solo acepta `localhost` o `127.0.0.1`, puerto `55439`, esquema
`public`, nombre de base `mindease_bootstrap_*` y `NODE_ENV` distinto de
`production`. Debe existir previamente una base nueva y vacía en ese servidor.
Por ejemplo, en el contenedor aislado de pruebas:

```powershell
docker exec mindease-isolated-interview-test createdb -U mindease_test mindease_bootstrap_example
$env:DATABASE_URL='postgresql://mindease_test:local_test_only@127.0.0.1:55439/mindease_bootstrap_example?schema=public'
$env:NODE_ENV='test'
node scripts/bootstrap-empty-local.cjs
npx prisma migrate status
```

No apunte este procedimiento a Railway, a una base restaurada ni a un esquema
con objetos. No hace copias de seguridad ni restaura usuarios, documentos o
datos. La recuperación de producción requiere un respaldo probado y una revisión
separada del historial y de los objetos no representados en Prisma.

Si cambia el esquema o se agrega/modifica alguna migración, las huellas harán
fallar el script deliberadamente: revise y regenere la instantánea y sus
controles en una base aislada. No marque migraciones nuevas como aplicadas sin
comprobar que sus efectos están incluidos. Las bases ya inicializadas deben
recibir migraciones futuras mediante el flujo habitual, no repetir el bootstrap.
