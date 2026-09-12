# Nexora TMS — Gap entre Documentação e Implementação

**Data:** 2026-09-12  
**Escopo:** documentação, runtime e dependências declaradas

## 1. Objetivo

Evitar que a documentação arquitetural seja interpretada como prova de implementação. Este relatório registra diferenças verificáveis entre o baseline arquitetural e os manifests atuais.

## 2. Confirmado no repositório

### Runtime

- Node.js `24.20.0` e pnpm `11.24.0` estão fixados no root `package.json`.
- Web usa Next.js `16.3.3` e React `19.2.8`.
- API usa NestJS `12.0.1`, `pg`, `jose`, `reflect-metadata` e RxJS.
- Worker usa NestJS `12.0.1` e `pg`.
- Turborepo, ESLint, Prettier e TypeScript estão configurados no workspace.

## 3. Pontos que exigem reconciliação

### Drizzle ORM

A documentação arquitetural define Drizzle ORM + SQL versionado como estratégia de persistência. Entretanto, o manifest auditado de `apps/api/package.json` não declara `drizzle-orm` nem um pacote de migration do Drizzle.

**Classificação:** P1 documental/implementação.  
**Ação:** confirmar se Drizzle está em outro package, se a persistência atual é SQL/`pg` puro ou se a dependência foi removida. Depois alinhar código, package manifests e documentação.

### Zod

A documentação define Zod como validação de boundary. O manifest auditado de `apps/api/package.json` não declara `zod`.

**Classificação:** P1 documental/implementação.  
**Ação:** confirmar implementação real de validação; adicionar dependência e integração se Zod continuar sendo a decisão arquitetural.

### Schema físico

A arquitetura define o schema `nexora`, tenant isolation, RLS e migrations versionadas. O catálogo físico final só pode ser emitido após inventário das migrations/SQL realmente presentes e aplicáveis.

**Classificação:** P1 de rastreabilidade.  
**Ação:** gerar catálogo automaticamente a partir do histórico SQL/Drizzle e validar em banco vazio.

### API completa

A documentação define `/api/v1` e uma matriz de recursos. Isso é contrato arquitetural e não comprova que todos os endpoints estejam implementados.

**Classificação:** P1 de rastreabilidade.  
**Ação:** gerar inventário real de controllers/routes e comparar com OpenAPI e matriz documental.

## 4. Regra para fechamento

Nenhum item acima deve ser marcado como concluído apenas por existir na documentação. O fechamento exige evidência no código, manifest, migration, teste ou ambiente correspondente.

## 5. Próxima sequência técnica

1. inventariar `apps/*` e `packages/*`;
2. localizar migrations/SQL e construir schema inventory;
3. identificar controllers/routes reais;
4. gerar OpenAPI inventory;
5. mapear cada endpoint para bounded context;
6. reconciliar Drizzle/Zod com implementação;
7. executar typecheck/lint/test/build;
8. atualizar documentação somente com fatos verificados;
9. criar ERD físico a partir do schema efetivo;
10. fechar P0/P1 restantes.
