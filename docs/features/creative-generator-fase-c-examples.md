# Fase C — casos de Subjects, Relations e Interactions

Gerado por `apps/creative-generator/scripts/render_fase_c_examples.py`, sem rede e sem OpenAI. Cada caso mostra o request, o CreativePlan (sem o texto do prompt), o prompt compilado, o `FeedbackSnapshot` e o `GenerationDraft`.

## Caso A — Pai e filha (recomendado pelo contexto semântico da estampa; nenhum subject no request)

### Request

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "single_product",
  "products": [
    {
      "id": "pipa-menina",
      "name": "Brincar com Meu Pai — Pipa Menina",
      "type": "camiseta infantil",
      "description": "camiseta infantil branca, estampa vermelha de pai e filha empinando pipa",
      "referenceImages": [
        "tenant-demo/products/pipa-menina/front.webp"
      ],
      "semantic_context": {
        "wearer_roles": [
          "child"
        ],
        "relationship_themes": [
          "father_child"
        ],
        "recommended_supporting_roles": [
          "father"
        ],
        "incompatible_auto_supporting_roles": [
          "mother"
        ],
        "scene_intents": [
          "play",
          "bond",
          "family"
        ],
        "visible_text": [
          "BRINCAR COM MEU PAI"
        ],
        "source": "manual"
      }
    }
  ],
  "brand_kit": {
    "id": "entre_nos_ab",
    "name": "Entre Nós",
    "schemaVersion": 1,
    "version": 1,
    "positioning": [
      "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
    ],
    "visualStyle": [
      "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
      "luz natural quente e suave, hora dourada ou luz de janela",
      "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
    ],
    "colors": [
      "creme e bege quente",
      "bordô/vinho profundo",
      "marrom terroso",
      "navy",
      "off-white"
    ],
    "manualNotes": [
      "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
      "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
      "Crianças em cena sempre à vontade e em interação real com o adulto."
    ],
    "avoid": [
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso"
    ],
    "suggestedPersonas": [
      {
        "label": "menina 6 anos",
        "source": "automatic"
      },
      {
        "label": "mulher 35 anos, mãe da menina",
        "source": "automatic"
      }
    ],
    "minorWardrobePolicy": {
      "enabled": true,
      "legs_coverage": "full",
      "allow_short_shorts": false,
      "allow_short_skirts": false,
      "allow_revealing_clothing": false,
      "style": "casual_age_appropriate"
    }
  },
  "niche_kit_id": "fashion",
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "persona_mode": "automatic",
  "context": {
    "mode": "custom",
    "profile": {
      "contextId": "entre_nos_sala",
      "contextType": "custom",
      "subject": {
        "name": "Sala de estar acolhedora"
      },
      "summary": "Rotina dentro de casa",
      "sceneContexts": [
        "sala de estar acolhedora com sofá, manta e luz natural lateral"
      ],
      "domainElements": [
        "manta de tricô jogada no encosto"
      ],
      "avoid": [
        "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado"
      ],
      "status": "approved",
      "schemaVersion": 1,
      "promptVersion": 1,
      "profileVersion": 1
    }
  },
  "quality": "medium",
  "seed": 100,
  "plan_schema_version": 2,
  "prompt_version": 2
}
```

### CreativePlan

```json
{
  "plan_id": "plan_67a011a87edf703b82021079",
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "schema_version": 2,
  "strategy": "CLEAN_ANGLES",
  "internal_strategy_id": "ANGULOS_LIMPOS",
  "product_mode": "single_product",
  "products": [
    {
      "id": "pipa-menina",
      "name": "Brincar com Meu Pai — Pipa Menina",
      "type": "camiseta infantil"
    }
  ],
  "angle": {
    "id": "LIFESTYLE_COTIDIANO",
    "label": "Lifestyle cotidiano",
    "description": "Pessoa em ação no dia a dia com o produto — nunca parada olhando para o nada.",
    "uses_person": true,
    "apparel_only": false,
    "multi_product_limit": 4
  },
  "placement": {
    "id": "FEED_4X5",
    "label": "Feed (4:5 — 1080×1350)",
    "width": 1080,
    "height": 1350,
    "api_size": "1088x1360"
  },
  "persona": {
    "label": "criança de 6 a 9 anos",
    "age_band": "child_6_9"
  },
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral",
    "supporting_element": "manta de tricô jogada no encosto",
    "avoid": [
      "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado",
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso",
      "peça deformada ou com proporção irreal",
      "tecido liso como vetor, sem trama",
      "produto parecendo adesivo colado na foto"
    ],
    "status": "approved",
    "profile_version": 1
  },
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "funnel_stage": null,
  "remarketing_intent": null,
  "layout": null,
  "overlay": {
    "allowed": false,
    "headline": null,
    "subheadline": null,
    "cta": null,
    "badges": [],
    "benefits": [],
    "search_bar_text": null,
    "chips": [],
    "text_density": null,
    "cta_emphasis": null,
    "clean": true
  },
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "prompt": {
    "text": "<5869 caracteres; ver abaixo>",
    "sections": [
      {
        "name": "fidelity_rules",
        "length": 1301,
        "source": "product",
        "value": "8"
      },
      {
        "name": "text_rules",
        "length": 509,
        "source": "user",
        "value": "clean_creative"
      },
      {
        "name": "minor_safety",
        "length": 474,
        "source": "safety_policy",
        "value": "minors:s1"
      },
      {
        "name": "reference_roles",
        "length": 200,
        "source": "product",
        "value": "refs:1"
      },
      {
        "name": "product_semantic_context",
        "length": 388,
        "source": "product",
        "value": "father_child"
      },
      {
        "name": "people_composition_contract",
        "length": 251,
        "source": "product",
        "value": "2"
      },
      {
        "name": "gaze",
        "length": 85,
        "source": "planner_default",
        "value": "interaction"
      },
      {
        "name": "interaction",
        "length": 281,
        "source": "product",
        "value": "playing"
      },
      {
        "name": "scene_action",
        "length": 214,
        "source": "angle",
        "value": "LIFESTYLE_COTIDIANO"
      },
      {
        "name": "minor_wardrobe_policy",
        "length": 273,
        "source": "brand",
        "value": "full"
      },
      {
        "name": "brand",
        "length": 827,
        "source": "brand",
        "value": "Entre Nós"
      },
      {
        "name": "niche",
        "length": 301,
        "source": "niche",
        "value": "Moda / Vestuário"
      },
      {
        "name": "context",
        "length": 223,
        "source": "user",
        "value": "entre_nos_sala"
      },
      {
        "name": "avoid",
        "length": 475,
        "source": "brand",
        "value": "7"
      },
      {
        "name": "output_format",
        "length": 39,
        "source": "user",
        "value": "FEED_4X5"
      }
    ],
    "sha256": "440bc5e589f5a8042463c658a00c7fc4434b49a05fc77652e140463fb9cb1643",
    "prompt_version": 2
  },
  "model": {
    "task": "image_generation",
    "model": "gpt-image-2",
    "quality": "medium",
    "size": "1088x1360"
  },
  "mode": "creative",
  "objective": "clean_creative",
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "label": "criança de 6 a 9 anos",
      "persona": {
        "label": "criança de 6 a 9 anos",
        "age_band": "child_6_9"
      },
      "age_band": "child_6_9",
      "is_minor": true,
      "age_source": "persona.age_band",
      "minor_source": "persona.age_band",
      "product_use": "wears",
      "product_id": "pipa-menina",
      "role_hint": null,
      "relation_to_primary": null,
      "relation_label": null,
      "prominence": "hero",
      "source": "product"
    },
    {
      "id": "s2",
      "role": "supporting",
      "label": "homem adulto",
      "persona": {
        "label": "homem adulto",
        "source": "automatic"
      },
      "age_band": "adult",
      "is_minor": false,
      "age_source": "persona.label",
      "minor_source": null,
      "product_use": "none",
      "product_id": null,
      "role_hint": "father",
      "relation_to_primary": "father",
      "relation_label": null,
      "prominence": "secondary",
      "source": "product"
    }
  ],
  "scene": {
    "gaze": {
      "mode": "interaction",
      "requested": "auto",
      "source": "planner_default",
      "reason": "interaction:playing"
    },
    "picks": {
      "acao": {
        "index": 4,
        "text": "chegando a um ambiente, cruzando a entrada com os braços soltos ao lado do corpo"
      }
    },
    "prompt_version": 2,
    "interaction": "playing",
    "interaction_detail": {
      "id": "playing",
      "catalog_version": 1,
      "label": "brincando",
      "min_people": 2,
      "max_people": 3,
      "excluded_bands": [
        "baby"
      ],
      "contact": "light",
      "hand_complexity": 2,
      "object_use": "heavy",
      "gaze_default": "interaction",
      "pose_risk": 2,
      "scene": "brincam juntas com um brinquedo simples e coerente com a estampa (uma pipa, uma bola, blocos), em atividade compartilhada ao ar livre ou em casa.",
      "hands": "cada pessoa segura o brinquedo com uma ou duas mãos, de forma simples; o objeto fica entre elas e visível."
    },
    "interaction_source": "product",
    "scene_mode": "frame",
    "composition_source": "recommended"
  },
  "composition": {
    "people_count": 2,
    "pose_risk": "medium",
    "risk_reasons": [
      "people:2",
      "interaction:playing"
    ]
  },
  "minor_safety": {
    "applies": true,
    "minor_subject_ids": [
      "s1"
    ],
    "global": {
      "policy": "global_minor_safety_policy",
      "version": 1,
      "rules": [
        "age_appropriate_clothing",
        "nothing_revealing",
        "not_sexualized",
        "no_adult_aesthetic",
        "age_appropriate_poses",
        "normal_fit_no_body_focus",
        "commercial_family_context"
      ],
      "adult_child_rule": "adult_child_contact_family_only"
    },
    "brand": {
      "policy": "brand_minor_wardrobe_policy",
      "source": "brand",
      "requested": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "effective": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "ignored": []
    },
    "basis": {
      "explicit": [
        "s1"
      ],
      "heuristic": []
    }
  },
  "semantics": {
    "products": [
      {
        "product_id": "pipa-menina",
        "semantic_context": {
          "wearer_roles": [
            "child"
          ],
          "relationship_themes": [
            "father_child"
          ],
          "recommended_supporting_roles": [
            "father"
          ],
          "incompatible_auto_supporting_roles": [
            "mother"
          ],
          "scene_intents": [
            "play",
            "bond",
            "family"
          ],
          "visible_text": [
            "BRINCAR COM MEU PAI"
          ],
          "source": "manual"
        }
      }
    ],
    "supporting": {
      "role": "father",
      "source": "product",
      "matched_role": "father",
      "recommended": true
    },
    "warnings": []
  },
  "resolved_inputs": {
    "brand": {
      "name": "Entre Nós",
      "positioning": [
        "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
      ],
      "visualStyle": [
        "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
        "luz natural quente e suave, hora dourada ou luz de janela",
        "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
      ],
      "colors": [
        "creme e bege quente",
        "bordô/vinho profundo",
        "marrom terroso",
        "navy",
        "off-white"
      ],
      "manualNotes": [
        "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
        "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
        "Crianças em cena sempre à vontade e em interação real com o adulto."
      ]
    },
    "niche": {
      "name": "Moda / Vestuário",
      "materials": [
        "algodão",
        "trama de tecido visível",
        "costuras e acabamento",
        "etiqueta discreta"
      ],
      "audienceBehaviors": [
        "compra pelo caimento e pelo estilo, não só pela estampa",
        "quer ver a peça vestida em corpo real",
        "compara tecido, acabamento e tamanho antes de decidir"
      ]
    },
    "strategy": {
      "text_rule": "MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.",
      "communication": ""
    }
  },
  "provenance": {
    "angle": "user",
    "brand_kit": "user",
    "compiler": "planner_default",
    "composition": "planner_default",
    "context": "user",
    "minor_safety.brand": "brand",
    "minor_safety.global": "safety_policy",
    "mode": "planner_default",
    "model": "planner_default",
    "niche_kit": "user",
    "objective": "user",
    "persona": "brand",
    "placement": "user",
    "products": "user",
    "quality": "user",
    "references": "product",
    "resolved_inputs": "brand",
    "scene": "mixed",
    "scene.gaze": "planner_default",
    "scene.interaction": "product",
    "scene.picks": "planner_default",
    "scene.prompt_version": "planner_default",
    "semantics": "product",
    "strategy": "user",
    "subjects": "product",
    "subjects.s1": "product",
    "subjects.s1.age_band": "product",
    "subjects.s2": "product",
    "subjects.s2.age_band": "product"
  },
  "provenance_sources": {
    "scene": [
      "planner_default",
      "product"
    ],
    "subjects": [
      "product"
    ]
  },
  "seed": 100,
  "compiler": {
    "version": 2,
    "sections": [
      {
        "section": "fidelity_rules",
        "source": "product",
        "length": 1301
      },
      {
        "section": "text_rules",
        "source": "user",
        "length": 509
      },
      {
        "section": "minor_safety",
        "source": "safety_policy",
        "length": 474
      },
      {
        "section": "reference_roles",
        "source": "product",
        "length": 200
      },
      {
        "section": "product_semantic_context",
        "source": "product",
        "length": 388
      },
      {
        "section": "people_composition_contract",
        "source": "product",
        "length": 251
      },
      {
        "section": "gaze",
        "source": "planner_default",
        "length": 85
      },
      {
        "section": "interaction",
        "source": "product",
        "length": 281
      },
      {
        "section": "scene_action",
        "source": "angle",
        "length": 214
      },
      {
        "section": "minor_wardrobe_policy",
        "source": "brand",
        "length": 273
      },
      {
        "section": "brand",
        "source": "brand",
        "length": 827
      },
      {
        "section": "niche",
        "source": "niche",
        "length": 301
      },
      {
        "section": "context",
        "source": "user",
        "length": 223
      },
      {
        "section": "avoid",
        "source": "brand",
        "length": 475
      },
      {
        "section": "output_format",
        "source": "user",
        "length": 39
      }
    ]
  },
  "versions": {
    "core_version": "1.1.0",
    "schema_version": 1,
    "prompt_version": 2,
    "brand_kit_schema_version": 1,
    "niche_kit_schema_version": 1,
    "context_profile_schema_version": 1,
    "clean_angles_version": 1,
    "remarketing_version": 1,
    "funnel_visual_version": 1,
    "strategy_version": 1,
    "compiler_version": 2,
    "brand_kit_version": 1,
    "niche_kit_version": 1,
    "context_profile_version": 1
  },
  "validations": [
    {
      "rule": "product_count_within_limits",
      "passed": true
    },
    {
      "rule": "angle_available_for_brand_and_niche",
      "passed": true
    },
    {
      "rule": "context_profile_approved",
      "passed": true
    },
    {
      "rule": "references_are_product_art_only",
      "passed": true
    },
    {
      "rule": "clean_angles_has_no_overlay",
      "passed": true
    }
  ],
  "warnings": []
}
```

### Prompt compilado

```text
REGRAS OBRIGATÓRIAS (nunca ignore):
- Preserve 100% o(s) produto(s) das imagens de referência — forma, cores, materiais, detalhes, estampas e textos originais idênticos; nunca invente, troque, duplique ou funda produtos.
- O produto deve parecer fotografado de verdade na cena: mesma luz, sombra, temperatura de cor e perspectiva do ambiente, textura real do material — nunca recortado ou colado como adesivo.
- Sem logotipos de terceiros, marca d'água, arroba de rede social ou endereço de site.
- Sem urgência falsa ("Só hoje", "Estoque limitado") e sem prova social fabricada (depoimento, nota, estrelas, número de clientes).
- Fotografia realista, alta qualidade, formato vertical.
- Preserve o TIPO DE PEÇA original: camiseta infantil, manga curta, gola redonda, tamanho de criança. O MODELO da cena é SEMPRE uma criança, NUNCA um adulto. Elementos culturais de adulto (ex: cuia de mate) NÃO devem ficar nas mãos da criança — podem aparecer só discretamente no cenário ao fundo, se fizer sentido.
- A estampa deve parecer IMPRESSA DE VERDADE no tecido: segue dobras e movimento, recebe a mesma luz e sombra da cena e mostra leve textura da trama por baixo da tinta — nunca lisa como vetor digital.
- Peças dobradas ou penduradas têm VOLUME real de tecido — nunca aparência achatada de recorte 2D.

MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.

PROTEÇÃO DE MENORES (regra absoluta, não negociável): há criança ou adolescente em cena. Sempre: roupa apropriada para a idade; nada revelador; nada sexualizado; nenhuma estética adulta (maquiagem, figurino ou pose de adulto); poses naturais e apropriadas à idade; peças com caimento normal, sem foco no corpo; contexto comercial, familiar e cotidiano coerente. Contato físico entre adulto e criança apenas em situação familiar ou cotidiana coerente com a relação declarada.

PRODUTO (autoridade absoluta sobre qualquer outra regra): imagem 1 = "Brincar com Meu Pai — Pipa Menina" (camiseta infantil) — camiseta infantil branca, estampa vermelha de pai e filha empinando pipa.

SEMÂNTICA DO PRODUTO (o significado da estampa orienta o clima da cena; não altera a pose, o enquadramento nem a quantidade de pessoas definidos abaixo):
  · "Brincar com Meu Pai — Pipa Menina" (camiseta infantil) — tema: pai e filho(a); quem veste: criança; a cena pode remeter a: brincar, vínculo, família; pessoa de apoio recomendada: pai; texto visível na peça: "BRINCAR COM MEU PAI".

COMPOSIÇÃO DE PESSOAS (contrato): exatamente 2 pessoas em quadro.
  · Pessoa 1 (principal): criança de 6 a 9 anos — veste "Brincar com Meu Pai — Pipa Menina" (camiseta infantil).
  · Pessoa 2 (apoio): homem adulto, pai da Pessoa 1 — não usa o produto.

OLHAR: as pessoas olham uma para a outra ou para a ação em curso — não para a câmera.

INTERAÇÃO (brincando): brincam juntas com um brinquedo simples e coerente com a estampa (uma pipa, uma bola, blocos), em atividade compartilhada ao ar livre ou em casa. Mãos: cada pessoa segura o brinquedo com uma ou duas mãos, de forma simples; o objeto fica entre elas e visível.

ÂNGULO LIFESTYLE COTIDIANO: as pessoas em ação natural no dia a dia, vivendo um momento real — nunca posadas nem paradas olhando para o nada. Cenário: sala de estar acolhedora com sofá, manta e luz natural lateral.

VESTUÁRIO DAS CRIANÇAS (política da marca): pernas totalmente cobertas — preferir calça, jeans, sarja, legging apropriada ou peças compridas; nenhuma composição que exponha demais as pernas; sem shorts curtos; sem saias curtas; roupas casuais infantis, apropriadas à idade.

MARCA (Entre Nós):
  · Posicionamento: camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa.
  · Linguagem visual: editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo, luz natural quente e suave, hora dourada ou luz de janela, materiais tácteis e domésticos: tecidos, madeira, linho, papel.
  · Paleta da marca (guia de cor da CENA, nunca do produto): creme e bege quente; bordô/vinho profundo; marrom terroso; navy; off-white.
  · Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.
  · Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.
  · Crianças em cena sempre à vontade e em interação real com o adulto.

NICHO (Moda / Vestuário):
  · Materiais e sinais de uso real: algodão, trama de tecido visível, costuras e acabamento, etiqueta discreta.
  · Público: compra pelo caimento e pelo estilo, não só pela estampa; quer ver a peça vestida em corpo real; compara tecido, acabamento e tamanho antes de decidir.

CONTEXTO DA CENA: sala de estar acolhedora com sofá, manta e luz natural lateral. Elemento de apoio, discreto: manta de tricô jogada no encosto. Contexto coerente e contemporâneo, sem caricatura nem cenário turístico óbvio.

EVITAR (não incluir na cena, mesmo que outra regra sugira algo parecido): qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado; estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans); clima de propaganda de margarina; cenário de imobiliária sem sinal de uso; peça deformada ou com proporção irreal; tecido liso como vetor, sem trama; produto parecendo adesivo colado na foto.

FORMATO: Feed 4:5 vertical (1080×1350).
```

### FeedbackSnapshot

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "plan_id": "plan_67a011a87edf703b82021079",
  "plan_schema_version": 2,
  "compiler_version": 2,
  "prompt_version": 2,
  "prompt_sha256": "440bc5e589f5a8042463c658a00c7fc4434b49a05fc77652e140463fb9cb1643",
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "angle": "LIFESTYLE_COTIDIANO",
  "product_ids": [
    "pipa-menina"
  ],
  "subjects": [
    {
      "role": "primary",
      "label": "criança de 6 a 9 anos",
      "age_band": "child_6_9",
      "is_minor": true,
      "product_use": "wears",
      "role_hint": null,
      "relation_to_primary": null
    },
    {
      "role": "supporting",
      "label": "homem adulto",
      "age_band": "adult",
      "is_minor": false,
      "product_use": "none",
      "role_hint": "father",
      "relation_to_primary": "father"
    }
  ],
  "people_count": 2,
  "interaction": "playing",
  "composition_source": "recommended",
  "composition_key": "p2|child_6_9+father|playing",
  "pose_risk": "medium",
  "warnings": [],
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "placement": "FEED_4X5",
  "quality": "medium",
  "gaze_mode": "interaction",
  "minor_safety_applied": true,
  "flags": {
    "normalize_references": null
  },
  "model": {
    "requested": "gpt-image-2",
    "served": null
  },
  "asset_sha256": null
}
```

### GenerationDraft

```json
{
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "single_product",
  "product_ids": [
    "pipa-menina"
  ],
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "quality": "medium",
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "persona_mode": "automatic",
  "persona": null,
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "persona": {
        "label": "criança de 6 a 9 anos",
        "age_band": "child_6_9"
      },
      "wears_product_id": "pipa-menina",
      "prominence": "hero",
      "age_band": "child_6_9"
    },
    {
      "id": "s2",
      "role": "supporting",
      "persona": {
        "label": "homem adulto",
        "source": "automatic"
      },
      "wears_product_id": null,
      "prominence": "secondary",
      "age_band": "adult",
      "relation_to_primary": "father"
    }
  ],
  "interaction": "playing",
  "scene_picks": {
    "acao": 4
  },
  "context": {
    "mode": "custom",
    "context_id": "entre_nos_sala",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "funnel_stage": null,
  "remarketing": null,
  "funnel": null,
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "gaze_mode": "interaction",
  "plan_schema_version": 2,
  "prompt_version": 2,
  "seed": 100,
  "plan_warnings": [],
  "actions": {
    "again": {
      "seed": 100,
      "scene_picks": {
        "acao": 4
      },
      "gaze_mode": "interaction"
    },
    "variation": {
      "seed": null,
      "scene_picks": null,
      "gaze_mode": "auto"
    }
  },
  "source": {
    "creative_id": "33333333-3333-4333-8333-333333333333",
    "plan_id": "plan_67a011a87edf703b82021079",
    "plan_schema_version": 2,
    "compiler_version": 2
  },
  "carried": [
    "mode",
    "objective",
    "product_ids",
    "angle_id",
    "placement_id",
    "quality",
    "brand_kit",
    "niche_kit",
    "subjects",
    "interaction",
    "context",
    "copy",
    "gaze_mode",
    "scene_picks",
    "seed"
  ]
}
```

## Caso B — Menino veste, mãe presente sem vestir, lendo juntos

### Request

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "single_product",
  "products": [
    {
      "id": "abelhinhas-leitura",
      "name": "Abelhinhas — Hora da Leitura",
      "type": "camiseta infantil",
      "description": "camiseta infantil com abelhinhas lendo",
      "referenceImages": [
        "tenant-demo/products/abelhinhas-leitura/front.webp"
      ],
      "semantic_context": {
        "wearer_roles": [
          "child"
        ],
        "relationship_themes": [
          "mother_child"
        ],
        "recommended_supporting_roles": [
          "mother"
        ],
        "incompatible_auto_supporting_roles": [
          "father"
        ],
        "scene_intents": [
          "reading",
          "bond"
        ],
        "source": "manual"
      }
    }
  ],
  "brand_kit": {
    "id": "entre_nos_ab",
    "name": "Entre Nós",
    "schemaVersion": 1,
    "version": 1,
    "positioning": [
      "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
    ],
    "visualStyle": [
      "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
      "luz natural quente e suave, hora dourada ou luz de janela",
      "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
    ],
    "colors": [
      "creme e bege quente",
      "bordô/vinho profundo",
      "marrom terroso",
      "navy",
      "off-white"
    ],
    "manualNotes": [
      "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
      "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
      "Crianças em cena sempre à vontade e em interação real com o adulto."
    ],
    "avoid": [
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso"
    ],
    "suggestedPersonas": [
      {
        "label": "menina 6 anos",
        "source": "automatic"
      },
      {
        "label": "mulher 35 anos, mãe da menina",
        "source": "automatic"
      }
    ],
    "minorWardrobePolicy": {
      "enabled": true,
      "legs_coverage": "full",
      "allow_short_shorts": false,
      "allow_short_skirts": false,
      "allow_revealing_clothing": false,
      "style": "casual_age_appropriate"
    }
  },
  "niche_kit_id": "fashion",
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "persona_mode": "automatic",
  "context": {
    "mode": "custom",
    "profile": {
      "contextId": "entre_nos_sala",
      "contextType": "custom",
      "subject": {
        "name": "Sala de estar acolhedora"
      },
      "summary": "Rotina dentro de casa",
      "sceneContexts": [
        "sala de estar acolhedora com sofá, manta e luz natural lateral"
      ],
      "domainElements": [
        "manta de tricô jogada no encosto"
      ],
      "avoid": [
        "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado"
      ],
      "status": "approved",
      "schemaVersion": 1,
      "promptVersion": 1,
      "profileVersion": 1
    }
  },
  "quality": "medium",
  "seed": 100,
  "plan_schema_version": 2,
  "prompt_version": 2,
  "subjects": [
    {
      "id": "menino",
      "role": "primary",
      "persona": {
        "label": "menino 7 anos",
        "age_band": "child_6_9"
      },
      "wears_product_id": "abelhinhas-leitura"
    },
    {
      "id": "mae",
      "role": "supporting",
      "persona": {
        "label": "mulher 34 anos",
        "age_band": "adult"
      },
      "relation_to_primary": "mother",
      "wears_product_id": null
    }
  ],
  "interaction": "reading_together"
}
```

### CreativePlan

```json
{
  "plan_id": "plan_6f8e30a84b6fb9c00faf1ded",
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "schema_version": 2,
  "strategy": "CLEAN_ANGLES",
  "internal_strategy_id": "ANGULOS_LIMPOS",
  "product_mode": "single_product",
  "products": [
    {
      "id": "abelhinhas-leitura",
      "name": "Abelhinhas — Hora da Leitura",
      "type": "camiseta infantil"
    }
  ],
  "angle": {
    "id": "LIFESTYLE_COTIDIANO",
    "label": "Lifestyle cotidiano",
    "description": "Pessoa em ação no dia a dia com o produto — nunca parada olhando para o nada.",
    "uses_person": true,
    "apparel_only": false,
    "multi_product_limit": 4
  },
  "placement": {
    "id": "FEED_4X5",
    "label": "Feed (4:5 — 1080×1350)",
    "width": 1080,
    "height": 1350,
    "api_size": "1088x1360"
  },
  "persona": {
    "label": "menino 7 anos",
    "age_band": "child_6_9"
  },
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral",
    "supporting_element": "manta de tricô jogada no encosto",
    "avoid": [
      "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado",
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso",
      "peça deformada ou com proporção irreal",
      "tecido liso como vetor, sem trama",
      "produto parecendo adesivo colado na foto"
    ],
    "status": "approved",
    "profile_version": 1
  },
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "funnel_stage": null,
  "remarketing_intent": null,
  "layout": null,
  "overlay": {
    "allowed": false,
    "headline": null,
    "subheadline": null,
    "cta": null,
    "badges": [],
    "benefits": [],
    "search_bar_text": null,
    "chips": [],
    "text_density": null,
    "cta_emphasis": null,
    "clean": true
  },
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "prompt": {
    "text": "<5751 caracteres; ver abaixo>",
    "sections": [
      {
        "name": "fidelity_rules",
        "length": 1301,
        "source": "product",
        "value": "8"
      },
      {
        "name": "text_rules",
        "length": 509,
        "source": "user",
        "value": "clean_creative"
      },
      {
        "name": "minor_safety",
        "length": 474,
        "source": "safety_policy",
        "value": "minors:s1"
      },
      {
        "name": "reference_roles",
        "length": 161,
        "source": "product",
        "value": "refs:1"
      },
      {
        "name": "product_semantic_context",
        "length": 328,
        "source": "product",
        "value": "mother_child"
      },
      {
        "name": "people_composition_contract",
        "length": 263,
        "source": "user",
        "value": "2"
      },
      {
        "name": "gaze",
        "length": 85,
        "source": "planner_default",
        "value": "interaction"
      },
      {
        "name": "interaction",
        "length": 250,
        "source": "user",
        "value": "reading_together"
      },
      {
        "name": "scene_action",
        "length": 214,
        "source": "angle",
        "value": "LIFESTYLE_COTIDIANO"
      },
      {
        "name": "minor_wardrobe_policy",
        "length": 273,
        "source": "brand",
        "value": "full"
      },
      {
        "name": "brand",
        "length": 827,
        "source": "brand",
        "value": "Entre Nós"
      },
      {
        "name": "niche",
        "length": 301,
        "source": "niche",
        "value": "Moda / Vestuário"
      },
      {
        "name": "context",
        "length": 223,
        "source": "user",
        "value": "entre_nos_sala"
      },
      {
        "name": "avoid",
        "length": 475,
        "source": "brand",
        "value": "7"
      },
      {
        "name": "output_format",
        "length": 39,
        "source": "user",
        "value": "FEED_4X5"
      }
    ],
    "sha256": "5f4780dc13eb757baff507ef49c75e67533f554b6b40698e0a47bbfbed5711a3",
    "prompt_version": 2
  },
  "model": {
    "task": "image_generation",
    "model": "gpt-image-2",
    "quality": "medium",
    "size": "1088x1360"
  },
  "mode": "creative",
  "objective": "clean_creative",
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "label": "menino 7 anos",
      "persona": {
        "label": "menino 7 anos",
        "age_band": "child_6_9"
      },
      "age_band": "child_6_9",
      "is_minor": true,
      "age_source": "persona.age_band",
      "minor_source": "persona.age_band",
      "product_use": "wears",
      "product_id": "abelhinhas-leitura",
      "role_hint": null,
      "relation_to_primary": null,
      "relation_label": null,
      "prominence": "hero",
      "source": "user"
    },
    {
      "id": "s2",
      "role": "supporting",
      "label": "mulher 34 anos",
      "persona": {
        "label": "mulher 34 anos",
        "age_band": "adult"
      },
      "age_band": "adult",
      "is_minor": false,
      "age_source": "persona.age_band",
      "minor_source": null,
      "product_use": "none",
      "product_id": null,
      "role_hint": "mother",
      "relation_to_primary": "mother",
      "relation_label": null,
      "prominence": "secondary",
      "source": "user"
    }
  ],
  "scene": {
    "gaze": {
      "mode": "interaction",
      "requested": "auto",
      "source": "planner_default",
      "reason": "interaction:reading_together"
    },
    "picks": {
      "acao": {
        "index": 4,
        "text": "chegando a um ambiente, cruzando a entrada com os braços soltos ao lado do corpo"
      }
    },
    "prompt_version": 2,
    "interaction": "reading_together",
    "interaction_detail": {
      "id": "reading_together",
      "catalog_version": 1,
      "label": "lendo juntos",
      "min_people": 2,
      "max_people": 3,
      "excluded_bands": [
        "baby"
      ],
      "contact": "light",
      "hand_complexity": 2,
      "object_use": "light",
      "gaze_default": "interaction",
      "pose_risk": 1,
      "scene": "leem um livro juntas, sentadas lado a lado, com o livro aberto apoiado no colo da pessoa mais nova.",
      "hands": "uma pessoa segura o livro pelas laterais e a outra apoia uma mão na página; nenhuma mão cruza o corpo de outra pessoa."
    },
    "interaction_source": "user",
    "scene_mode": "frame",
    "composition_source": "explicit"
  },
  "composition": {
    "people_count": 2,
    "pose_risk": "medium",
    "risk_reasons": [
      "people:2",
      "interaction:reading_together"
    ]
  },
  "minor_safety": {
    "applies": true,
    "minor_subject_ids": [
      "s1"
    ],
    "global": {
      "policy": "global_minor_safety_policy",
      "version": 1,
      "rules": [
        "age_appropriate_clothing",
        "nothing_revealing",
        "not_sexualized",
        "no_adult_aesthetic",
        "age_appropriate_poses",
        "normal_fit_no_body_focus",
        "commercial_family_context"
      ],
      "adult_child_rule": "adult_child_contact_family_only"
    },
    "brand": {
      "policy": "brand_minor_wardrobe_policy",
      "source": "brand",
      "requested": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "effective": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "ignored": []
    },
    "basis": {
      "explicit": [
        "s1"
      ],
      "heuristic": []
    }
  },
  "semantics": {
    "products": [
      {
        "product_id": "abelhinhas-leitura",
        "semantic_context": {
          "wearer_roles": [
            "child"
          ],
          "relationship_themes": [
            "mother_child"
          ],
          "recommended_supporting_roles": [
            "mother"
          ],
          "incompatible_auto_supporting_roles": [
            "father"
          ],
          "scene_intents": [
            "reading",
            "bond"
          ],
          "source": "manual"
        }
      }
    ],
    "supporting": null,
    "warnings": []
  },
  "resolved_inputs": {
    "brand": {
      "name": "Entre Nós",
      "positioning": [
        "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
      ],
      "visualStyle": [
        "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
        "luz natural quente e suave, hora dourada ou luz de janela",
        "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
      ],
      "colors": [
        "creme e bege quente",
        "bordô/vinho profundo",
        "marrom terroso",
        "navy",
        "off-white"
      ],
      "manualNotes": [
        "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
        "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
        "Crianças em cena sempre à vontade e em interação real com o adulto."
      ]
    },
    "niche": {
      "name": "Moda / Vestuário",
      "materials": [
        "algodão",
        "trama de tecido visível",
        "costuras e acabamento",
        "etiqueta discreta"
      ],
      "audienceBehaviors": [
        "compra pelo caimento e pelo estilo, não só pela estampa",
        "quer ver a peça vestida em corpo real",
        "compara tecido, acabamento e tamanho antes de decidir"
      ]
    },
    "strategy": {
      "text_rule": "MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.",
      "communication": ""
    }
  },
  "provenance": {
    "angle": "user",
    "brand_kit": "user",
    "compiler": "planner_default",
    "composition": "planner_default",
    "context": "user",
    "minor_safety.brand": "brand",
    "minor_safety.global": "safety_policy",
    "mode": "planner_default",
    "model": "planner_default",
    "niche_kit": "user",
    "objective": "user",
    "persona": "brand",
    "placement": "user",
    "products": "user",
    "quality": "user",
    "references": "product",
    "resolved_inputs": "brand",
    "scene": "mixed",
    "scene.gaze": "planner_default",
    "scene.interaction": "user",
    "scene.picks": "planner_default",
    "scene.prompt_version": "planner_default",
    "semantics": "product",
    "strategy": "user",
    "subjects": "user",
    "subjects.s1": "user",
    "subjects.s1.age_band": "persona",
    "subjects.s2": "user",
    "subjects.s2.age_band": "persona"
  },
  "provenance_sources": {
    "scene": [
      "planner_default",
      "user"
    ],
    "subjects": [
      "user"
    ]
  },
  "seed": 100,
  "compiler": {
    "version": 2,
    "sections": [
      {
        "section": "fidelity_rules",
        "source": "product",
        "length": 1301
      },
      {
        "section": "text_rules",
        "source": "user",
        "length": 509
      },
      {
        "section": "minor_safety",
        "source": "safety_policy",
        "length": 474
      },
      {
        "section": "reference_roles",
        "source": "product",
        "length": 161
      },
      {
        "section": "product_semantic_context",
        "source": "product",
        "length": 328
      },
      {
        "section": "people_composition_contract",
        "source": "user",
        "length": 263
      },
      {
        "section": "gaze",
        "source": "planner_default",
        "length": 85
      },
      {
        "section": "interaction",
        "source": "user",
        "length": 250
      },
      {
        "section": "scene_action",
        "source": "angle",
        "length": 214
      },
      {
        "section": "minor_wardrobe_policy",
        "source": "brand",
        "length": 273
      },
      {
        "section": "brand",
        "source": "brand",
        "length": 827
      },
      {
        "section": "niche",
        "source": "niche",
        "length": 301
      },
      {
        "section": "context",
        "source": "user",
        "length": 223
      },
      {
        "section": "avoid",
        "source": "brand",
        "length": 475
      },
      {
        "section": "output_format",
        "source": "user",
        "length": 39
      }
    ]
  },
  "versions": {
    "core_version": "1.1.0",
    "schema_version": 1,
    "prompt_version": 2,
    "brand_kit_schema_version": 1,
    "niche_kit_schema_version": 1,
    "context_profile_schema_version": 1,
    "clean_angles_version": 1,
    "remarketing_version": 1,
    "funnel_visual_version": 1,
    "strategy_version": 1,
    "compiler_version": 2,
    "brand_kit_version": 1,
    "niche_kit_version": 1,
    "context_profile_version": 1
  },
  "validations": [
    {
      "rule": "product_count_within_limits",
      "passed": true
    },
    {
      "rule": "angle_available_for_brand_and_niche",
      "passed": true
    },
    {
      "rule": "context_profile_approved",
      "passed": true
    },
    {
      "rule": "references_are_product_art_only",
      "passed": true
    },
    {
      "rule": "clean_angles_has_no_overlay",
      "passed": true
    }
  ],
  "warnings": []
}
```

### Prompt compilado

```text
REGRAS OBRIGATÓRIAS (nunca ignore):
- Preserve 100% o(s) produto(s) das imagens de referência — forma, cores, materiais, detalhes, estampas e textos originais idênticos; nunca invente, troque, duplique ou funda produtos.
- O produto deve parecer fotografado de verdade na cena: mesma luz, sombra, temperatura de cor e perspectiva do ambiente, textura real do material — nunca recortado ou colado como adesivo.
- Sem logotipos de terceiros, marca d'água, arroba de rede social ou endereço de site.
- Sem urgência falsa ("Só hoje", "Estoque limitado") e sem prova social fabricada (depoimento, nota, estrelas, número de clientes).
- Fotografia realista, alta qualidade, formato vertical.
- Preserve o TIPO DE PEÇA original: camiseta infantil, manga curta, gola redonda, tamanho de criança. O MODELO da cena é SEMPRE uma criança, NUNCA um adulto. Elementos culturais de adulto (ex: cuia de mate) NÃO devem ficar nas mãos da criança — podem aparecer só discretamente no cenário ao fundo, se fizer sentido.
- A estampa deve parecer IMPRESSA DE VERDADE no tecido: segue dobras e movimento, recebe a mesma luz e sombra da cena e mostra leve textura da trama por baixo da tinta — nunca lisa como vetor digital.
- Peças dobradas ou penduradas têm VOLUME real de tecido — nunca aparência achatada de recorte 2D.

MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.

PROTEÇÃO DE MENORES (regra absoluta, não negociável): há criança ou adolescente em cena. Sempre: roupa apropriada para a idade; nada revelador; nada sexualizado; nenhuma estética adulta (maquiagem, figurino ou pose de adulto); poses naturais e apropriadas à idade; peças com caimento normal, sem foco no corpo; contexto comercial, familiar e cotidiano coerente. Contato físico entre adulto e criança apenas em situação familiar ou cotidiana coerente com a relação declarada.

PRODUTO (autoridade absoluta sobre qualquer outra regra): imagem 1 = "Abelhinhas — Hora da Leitura" (camiseta infantil) — camiseta infantil com abelhinhas lendo.

SEMÂNTICA DO PRODUTO (o significado da estampa orienta o clima da cena; não altera a pose, o enquadramento nem a quantidade de pessoas definidos abaixo):
  · "Abelhinhas — Hora da Leitura" (camiseta infantil) — tema: mãe e filho(a); quem veste: criança; a cena pode remeter a: leitura, vínculo; pessoa de apoio recomendada: mãe.

COMPOSIÇÃO DE PESSOAS (contrato): exatamente 2 pessoas em quadro.
  · Pessoa 1 (principal): menino 7 anos, criança de 6 a 9 anos — veste "Abelhinhas — Hora da Leitura" (camiseta infantil).
  · Pessoa 2 (apoio): mulher 34 anos, mãe da Pessoa 1 — não usa o produto.

OLHAR: as pessoas olham uma para a outra ou para a ação em curso — não para a câmera.

INTERAÇÃO (lendo juntos): leem um livro juntas, sentadas lado a lado, com o livro aberto apoiado no colo da pessoa mais nova. Mãos: uma pessoa segura o livro pelas laterais e a outra apoia uma mão na página; nenhuma mão cruza o corpo de outra pessoa.

ÂNGULO LIFESTYLE COTIDIANO: as pessoas em ação natural no dia a dia, vivendo um momento real — nunca posadas nem paradas olhando para o nada. Cenário: sala de estar acolhedora com sofá, manta e luz natural lateral.

VESTUÁRIO DAS CRIANÇAS (política da marca): pernas totalmente cobertas — preferir calça, jeans, sarja, legging apropriada ou peças compridas; nenhuma composição que exponha demais as pernas; sem shorts curtos; sem saias curtas; roupas casuais infantis, apropriadas à idade.

MARCA (Entre Nós):
  · Posicionamento: camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa.
  · Linguagem visual: editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo, luz natural quente e suave, hora dourada ou luz de janela, materiais tácteis e domésticos: tecidos, madeira, linho, papel.
  · Paleta da marca (guia de cor da CENA, nunca do produto): creme e bege quente; bordô/vinho profundo; marrom terroso; navy; off-white.
  · Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.
  · Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.
  · Crianças em cena sempre à vontade e em interação real com o adulto.

NICHO (Moda / Vestuário):
  · Materiais e sinais de uso real: algodão, trama de tecido visível, costuras e acabamento, etiqueta discreta.
  · Público: compra pelo caimento e pelo estilo, não só pela estampa; quer ver a peça vestida em corpo real; compara tecido, acabamento e tamanho antes de decidir.

CONTEXTO DA CENA: sala de estar acolhedora com sofá, manta e luz natural lateral. Elemento de apoio, discreto: manta de tricô jogada no encosto. Contexto coerente e contemporâneo, sem caricatura nem cenário turístico óbvio.

EVITAR (não incluir na cena, mesmo que outra regra sugira algo parecido): qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado; estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans); clima de propaganda de margarina; cenário de imobiliária sem sinal de uso; peça deformada ou com proporção irreal; tecido liso como vetor, sem trama; produto parecendo adesivo colado na foto.

FORMATO: Feed 4:5 vertical (1080×1350).
```

### FeedbackSnapshot

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "plan_id": "plan_6f8e30a84b6fb9c00faf1ded",
  "plan_schema_version": 2,
  "compiler_version": 2,
  "prompt_version": 2,
  "prompt_sha256": "5f4780dc13eb757baff507ef49c75e67533f554b6b40698e0a47bbfbed5711a3",
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "angle": "LIFESTYLE_COTIDIANO",
  "product_ids": [
    "abelhinhas-leitura"
  ],
  "subjects": [
    {
      "role": "primary",
      "label": "menino 7 anos",
      "age_band": "child_6_9",
      "is_minor": true,
      "product_use": "wears",
      "role_hint": null,
      "relation_to_primary": null
    },
    {
      "role": "supporting",
      "label": "mulher 34 anos",
      "age_band": "adult",
      "is_minor": false,
      "product_use": "none",
      "role_hint": "mother",
      "relation_to_primary": "mother"
    }
  ],
  "people_count": 2,
  "interaction": "reading_together",
  "composition_source": "explicit",
  "composition_key": "p2|child_6_9+mother|reading_together",
  "pose_risk": "medium",
  "warnings": [],
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "placement": "FEED_4X5",
  "quality": "medium",
  "gaze_mode": "interaction",
  "minor_safety_applied": true,
  "flags": {
    "normalize_references": null
  },
  "model": {
    "requested": "gpt-image-2",
    "served": null
  },
  "asset_sha256": null
}
```

### GenerationDraft

```json
{
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "single_product",
  "product_ids": [
    "abelhinhas-leitura"
  ],
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "quality": "medium",
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "persona_mode": "automatic",
  "persona": null,
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "persona": {
        "label": "menino 7 anos",
        "age_band": "child_6_9"
      },
      "wears_product_id": "abelhinhas-leitura",
      "prominence": "hero",
      "age_band": "child_6_9"
    },
    {
      "id": "s2",
      "role": "supporting",
      "persona": {
        "label": "mulher 34 anos",
        "age_band": "adult"
      },
      "wears_product_id": null,
      "prominence": "secondary",
      "age_band": "adult",
      "relation_to_primary": "mother"
    }
  ],
  "interaction": "reading_together",
  "scene_picks": {
    "acao": 4
  },
  "context": {
    "mode": "custom",
    "context_id": "entre_nos_sala",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "funnel_stage": null,
  "remarketing": null,
  "funnel": null,
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "gaze_mode": "interaction",
  "plan_schema_version": 2,
  "prompt_version": 2,
  "seed": 100,
  "plan_warnings": [],
  "actions": {
    "again": {
      "seed": 100,
      "scene_picks": {
        "acao": 4
      },
      "gaze_mode": "interaction"
    },
    "variation": {
      "seed": null,
      "scene_picks": null,
      "gaze_mode": "auto"
    }
  },
  "source": {
    "creative_id": "33333333-3333-4333-8333-333333333333",
    "plan_id": "plan_6f8e30a84b6fb9c00faf1ded",
    "plan_schema_version": 2,
    "compiler_version": 2
  },
  "carried": [
    "mode",
    "objective",
    "product_ids",
    "angle_id",
    "placement_id",
    "quality",
    "brand_kit",
    "niche_kit",
    "subjects",
    "interaction",
    "context",
    "copy",
    "gaze_mode",
    "scene_picks",
    "seed"
  ]
}
```

## Caso C — Duas irmãs com produtos diferentes

### Request

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "multi_product",
  "products": [
    {
      "id": "irmas-rosa",
      "name": "Irmãs em União — Rosa",
      "type": "camiseta infantil",
      "description": "camiseta infantil rosa, duas irmãs de mãos dadas",
      "referenceImages": [
        "tenant-demo/products/irmas-rosa/front.webp"
      ],
      "semantic_context": {
        "wearer_roles": [
          "child"
        ],
        "relationship_themes": [
          "siblings"
        ],
        "recommended_supporting_roles": [
          "sibling"
        ],
        "scene_intents": [
          "bond",
          "play"
        ],
        "source": "manual"
      }
    },
    {
      "id": "irmas-azul",
      "name": "Irmãs em União — Azul",
      "type": "camiseta infantil",
      "description": "camiseta infantil azul, duas irmãs de mãos dadas",
      "referenceImages": [
        "tenant-demo/products/irmas-azul/front.webp"
      ],
      "semantic_context": {
        "wearer_roles": [
          "child"
        ],
        "relationship_themes": [
          "siblings"
        ],
        "recommended_supporting_roles": [
          "sibling"
        ],
        "scene_intents": [
          "bond",
          "play"
        ],
        "source": "manual"
      }
    }
  ],
  "brand_kit": {
    "id": "entre_nos_ab",
    "name": "Entre Nós",
    "schemaVersion": 1,
    "version": 1,
    "positioning": [
      "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
    ],
    "visualStyle": [
      "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
      "luz natural quente e suave, hora dourada ou luz de janela",
      "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
    ],
    "colors": [
      "creme e bege quente",
      "bordô/vinho profundo",
      "marrom terroso",
      "navy",
      "off-white"
    ],
    "manualNotes": [
      "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
      "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
      "Crianças em cena sempre à vontade e em interação real com o adulto."
    ],
    "avoid": [
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso"
    ],
    "suggestedPersonas": [
      {
        "label": "menina 6 anos",
        "source": "automatic"
      },
      {
        "label": "mulher 35 anos, mãe da menina",
        "source": "automatic"
      }
    ],
    "minorWardrobePolicy": {
      "enabled": true,
      "legs_coverage": "full",
      "allow_short_shorts": false,
      "allow_short_skirts": false,
      "allow_revealing_clothing": false,
      "style": "casual_age_appropriate"
    }
  },
  "niche_kit_id": "fashion",
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "persona_mode": "automatic",
  "context": {
    "mode": "custom",
    "profile": {
      "contextId": "entre_nos_sala",
      "contextType": "custom",
      "subject": {
        "name": "Sala de estar acolhedora"
      },
      "summary": "Rotina dentro de casa",
      "sceneContexts": [
        "sala de estar acolhedora com sofá, manta e luz natural lateral"
      ],
      "domainElements": [
        "manta de tricô jogada no encosto"
      ],
      "avoid": [
        "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado"
      ],
      "status": "approved",
      "schemaVersion": 1,
      "promptVersion": 1,
      "profileVersion": 1
    }
  },
  "quality": "medium",
  "seed": 100,
  "plan_schema_version": 2,
  "prompt_version": 2,
  "subjects": [
    {
      "id": "irma1",
      "role": "primary",
      "persona": {
        "label": "menina 8 anos",
        "age_band": "child_6_9"
      },
      "wears_product_id": "irmas-rosa"
    },
    {
      "id": "irma2",
      "role": "supporting",
      "persona": {
        "label": "menina 5 anos",
        "age_band": "child_3_5"
      },
      "relation_to_primary": "sibling",
      "wears_product_id": "irmas-azul"
    }
  ],
  "interaction": "candid"
}
```

### CreativePlan

```json
{
  "plan_id": "plan_b8d64b39f07767e71f6231a7",
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "schema_version": 2,
  "strategy": "CLEAN_ANGLES",
  "internal_strategy_id": "ANGULOS_LIMPOS",
  "product_mode": "multi_product",
  "products": [
    {
      "id": "irmas-rosa",
      "name": "Irmãs em União — Rosa",
      "type": "camiseta infantil"
    },
    {
      "id": "irmas-azul",
      "name": "Irmãs em União — Azul",
      "type": "camiseta infantil"
    }
  ],
  "angle": {
    "id": "LIFESTYLE_COTIDIANO",
    "label": "Lifestyle cotidiano",
    "description": "Pessoa em ação no dia a dia com o produto — nunca parada olhando para o nada.",
    "uses_person": true,
    "apparel_only": false,
    "multi_product_limit": 4
  },
  "placement": {
    "id": "FEED_4X5",
    "label": "Feed (4:5 — 1080×1350)",
    "width": 1080,
    "height": 1350,
    "api_size": "1088x1360"
  },
  "persona": {
    "label": "menina 8 anos",
    "age_band": "child_6_9"
  },
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral",
    "supporting_element": "manta de tricô jogada no encosto",
    "avoid": [
      "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado",
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso",
      "peça deformada ou com proporção irreal",
      "tecido liso como vetor, sem trama",
      "produto parecendo adesivo colado na foto"
    ],
    "status": "approved",
    "profile_version": 1
  },
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "funnel_stage": null,
  "remarketing_intent": null,
  "layout": null,
  "overlay": {
    "allowed": false,
    "headline": null,
    "subheadline": null,
    "cta": null,
    "badges": [],
    "benefits": [],
    "search_bar_text": null,
    "chips": [],
    "text_density": null,
    "cta_emphasis": null,
    "clean": true
  },
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "prompt": {
    "text": "<6166 caracteres; ver abaixo>",
    "sections": [
      {
        "name": "fidelity_rules",
        "length": 1301,
        "source": "product",
        "value": "8"
      },
      {
        "name": "text_rules",
        "length": 509,
        "source": "user",
        "value": "clean_creative"
      },
      {
        "name": "minor_safety",
        "length": 361,
        "source": "safety_policy",
        "value": "minors:s1,s2"
      },
      {
        "name": "reference_roles",
        "length": 395,
        "source": "product",
        "value": "refs:2"
      },
      {
        "name": "product_semantic_context",
        "length": 493,
        "source": "product",
        "value": "siblings"
      },
      {
        "name": "people_composition_contract",
        "length": 320,
        "source": "user",
        "value": "2"
      },
      {
        "name": "gaze",
        "length": 131,
        "source": "planner_default",
        "value": "off_camera"
      },
      {
        "name": "interaction",
        "length": 276,
        "source": "user",
        "value": "candid"
      },
      {
        "name": "scene_action",
        "length": 214,
        "source": "angle",
        "value": "LIFESTYLE_COTIDIANO"
      },
      {
        "name": "minor_wardrobe_policy",
        "length": 273,
        "source": "brand",
        "value": "full"
      },
      {
        "name": "brand",
        "length": 827,
        "source": "brand",
        "value": "Entre Nós"
      },
      {
        "name": "niche",
        "length": 301,
        "source": "niche",
        "value": "Moda / Vestuário"
      },
      {
        "name": "context",
        "length": 223,
        "source": "user",
        "value": "entre_nos_sala"
      },
      {
        "name": "avoid",
        "length": 475,
        "source": "brand",
        "value": "7"
      },
      {
        "name": "output_format",
        "length": 39,
        "source": "user",
        "value": "FEED_4X5"
      }
    ],
    "sha256": "2c6f03366ded731828d7f32b86eae4c7b6b28e5391dfafca0c8d4c38a58c828a",
    "prompt_version": 2
  },
  "model": {
    "task": "image_generation",
    "model": "gpt-image-2",
    "quality": "medium",
    "size": "1088x1360"
  },
  "mode": "creative",
  "objective": "clean_creative",
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "label": "menina 8 anos",
      "persona": {
        "label": "menina 8 anos",
        "age_band": "child_6_9"
      },
      "age_band": "child_6_9",
      "is_minor": true,
      "age_source": "persona.age_band",
      "minor_source": "persona.age_band",
      "product_use": "wears",
      "product_id": "irmas-rosa",
      "role_hint": null,
      "relation_to_primary": null,
      "relation_label": null,
      "prominence": "hero",
      "source": "user"
    },
    {
      "id": "s2",
      "role": "supporting",
      "label": "menina 5 anos",
      "persona": {
        "label": "menina 5 anos",
        "age_band": "child_3_5"
      },
      "age_band": "child_3_5",
      "is_minor": true,
      "age_source": "persona.age_band",
      "minor_source": "persona.age_band",
      "product_use": "wears",
      "product_id": "irmas-azul",
      "role_hint": "sibling",
      "relation_to_primary": "sibling",
      "relation_label": null,
      "prominence": "secondary",
      "source": "user"
    }
  ],
  "scene": {
    "gaze": {
      "mode": "off_camera",
      "requested": "auto",
      "source": "planner_default",
      "reason": "interaction:candid"
    },
    "picks": {
      "acao": {
        "index": 4,
        "text": "chegando a um ambiente, cruzando a entrada com os braços soltos ao lado do corpo"
      }
    },
    "prompt_version": 2,
    "interaction": "candid",
    "interaction_detail": {
      "id": "candid",
      "catalog_version": 1,
      "label": "espontâneo",
      "min_people": 1,
      "max_people": 4,
      "excluded_bands": [],
      "contact": "none",
      "hand_complexity": 0,
      "object_use": "none",
      "gaze_default": "off_camera",
      "pose_risk": 0,
      "scene": "as pessoas convivem de forma natural e espontânea, lado a lado ou levemente voltadas umas para as outras, sem posar para a câmera.",
      "hands": "mãos relaxadas ao lado do corpo ou apoiadas numa superfície do ambiente; nenhuma mão cruza o corpo de outra pessoa."
    },
    "interaction_source": "user",
    "scene_mode": "frame",
    "composition_source": "explicit"
  },
  "composition": {
    "people_count": 2,
    "pose_risk": "low",
    "risk_reasons": [
      "people:2"
    ]
  },
  "minor_safety": {
    "applies": true,
    "minor_subject_ids": [
      "s1",
      "s2"
    ],
    "global": {
      "policy": "global_minor_safety_policy",
      "version": 1,
      "rules": [
        "age_appropriate_clothing",
        "nothing_revealing",
        "not_sexualized",
        "no_adult_aesthetic",
        "age_appropriate_poses",
        "normal_fit_no_body_focus",
        "commercial_family_context"
      ],
      "adult_child_rule": null
    },
    "brand": {
      "policy": "brand_minor_wardrobe_policy",
      "source": "brand",
      "requested": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "effective": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "ignored": []
    },
    "basis": {
      "explicit": [
        "s1",
        "s2"
      ],
      "heuristic": []
    }
  },
  "semantics": {
    "products": [
      {
        "product_id": "irmas-rosa",
        "semantic_context": {
          "wearer_roles": [
            "child"
          ],
          "relationship_themes": [
            "siblings"
          ],
          "recommended_supporting_roles": [
            "sibling"
          ],
          "scene_intents": [
            "bond",
            "play"
          ],
          "source": "manual"
        }
      },
      {
        "product_id": "irmas-azul",
        "semantic_context": {
          "wearer_roles": [
            "child"
          ],
          "relationship_themes": [
            "siblings"
          ],
          "recommended_supporting_roles": [
            "sibling"
          ],
          "scene_intents": [
            "bond",
            "play"
          ],
          "source": "manual"
        }
      }
    ],
    "supporting": null,
    "warnings": []
  },
  "resolved_inputs": {
    "brand": {
      "name": "Entre Nós",
      "positioning": [
        "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
      ],
      "visualStyle": [
        "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
        "luz natural quente e suave, hora dourada ou luz de janela",
        "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
      ],
      "colors": [
        "creme e bege quente",
        "bordô/vinho profundo",
        "marrom terroso",
        "navy",
        "off-white"
      ],
      "manualNotes": [
        "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
        "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
        "Crianças em cena sempre à vontade e em interação real com o adulto."
      ]
    },
    "niche": {
      "name": "Moda / Vestuário",
      "materials": [
        "algodão",
        "trama de tecido visível",
        "costuras e acabamento",
        "etiqueta discreta"
      ],
      "audienceBehaviors": [
        "compra pelo caimento e pelo estilo, não só pela estampa",
        "quer ver a peça vestida em corpo real",
        "compara tecido, acabamento e tamanho antes de decidir"
      ]
    },
    "strategy": {
      "text_rule": "MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.",
      "communication": ""
    }
  },
  "provenance": {
    "angle": "user",
    "brand_kit": "user",
    "compiler": "planner_default",
    "composition": "planner_default",
    "context": "user",
    "minor_safety.brand": "brand",
    "minor_safety.global": "safety_policy",
    "mode": "planner_default",
    "model": "planner_default",
    "niche_kit": "user",
    "objective": "user",
    "persona": "brand",
    "placement": "user",
    "products": "user",
    "quality": "user",
    "references": "product",
    "resolved_inputs": "brand",
    "scene": "mixed",
    "scene.gaze": "planner_default",
    "scene.interaction": "user",
    "scene.picks": "planner_default",
    "scene.prompt_version": "planner_default",
    "semantics": "product",
    "strategy": "user",
    "subjects": "user",
    "subjects.s1": "user",
    "subjects.s1.age_band": "persona",
    "subjects.s2": "user",
    "subjects.s2.age_band": "persona"
  },
  "provenance_sources": {
    "scene": [
      "planner_default",
      "user"
    ],
    "subjects": [
      "user"
    ]
  },
  "seed": 100,
  "compiler": {
    "version": 2,
    "sections": [
      {
        "section": "fidelity_rules",
        "source": "product",
        "length": 1301
      },
      {
        "section": "text_rules",
        "source": "user",
        "length": 509
      },
      {
        "section": "minor_safety",
        "source": "safety_policy",
        "length": 361
      },
      {
        "section": "reference_roles",
        "source": "product",
        "length": 395
      },
      {
        "section": "product_semantic_context",
        "source": "product",
        "length": 493
      },
      {
        "section": "people_composition_contract",
        "source": "user",
        "length": 320
      },
      {
        "section": "gaze",
        "source": "planner_default",
        "length": 131
      },
      {
        "section": "interaction",
        "source": "user",
        "length": 276
      },
      {
        "section": "scene_action",
        "source": "angle",
        "length": 214
      },
      {
        "section": "minor_wardrobe_policy",
        "source": "brand",
        "length": 273
      },
      {
        "section": "brand",
        "source": "brand",
        "length": 827
      },
      {
        "section": "niche",
        "source": "niche",
        "length": 301
      },
      {
        "section": "context",
        "source": "user",
        "length": 223
      },
      {
        "section": "avoid",
        "source": "brand",
        "length": 475
      },
      {
        "section": "output_format",
        "source": "user",
        "length": 39
      }
    ]
  },
  "versions": {
    "core_version": "1.1.0",
    "schema_version": 1,
    "prompt_version": 2,
    "brand_kit_schema_version": 1,
    "niche_kit_schema_version": 1,
    "context_profile_schema_version": 1,
    "clean_angles_version": 1,
    "remarketing_version": 1,
    "funnel_visual_version": 1,
    "strategy_version": 1,
    "compiler_version": 2,
    "brand_kit_version": 1,
    "niche_kit_version": 1,
    "context_profile_version": 1
  },
  "validations": [
    {
      "rule": "product_count_within_limits",
      "passed": true
    },
    {
      "rule": "angle_available_for_brand_and_niche",
      "passed": true
    },
    {
      "rule": "context_profile_approved",
      "passed": true
    },
    {
      "rule": "references_are_product_art_only",
      "passed": true
    },
    {
      "rule": "clean_angles_has_no_overlay",
      "passed": true
    }
  ],
  "warnings": []
}
```

### Prompt compilado

```text
REGRAS OBRIGATÓRIAS (nunca ignore):
- Preserve 100% o(s) produto(s) das imagens de referência — forma, cores, materiais, detalhes, estampas e textos originais idênticos; nunca invente, troque, duplique ou funda produtos.
- O produto deve parecer fotografado de verdade na cena: mesma luz, sombra, temperatura de cor e perspectiva do ambiente, textura real do material — nunca recortado ou colado como adesivo.
- Sem logotipos de terceiros, marca d'água, arroba de rede social ou endereço de site.
- Sem urgência falsa ("Só hoje", "Estoque limitado") e sem prova social fabricada (depoimento, nota, estrelas, número de clientes).
- Fotografia realista, alta qualidade, formato vertical.
- Preserve o TIPO DE PEÇA original: camiseta infantil, manga curta, gola redonda, tamanho de criança. O MODELO da cena é SEMPRE uma criança, NUNCA um adulto. Elementos culturais de adulto (ex: cuia de mate) NÃO devem ficar nas mãos da criança — podem aparecer só discretamente no cenário ao fundo, se fizer sentido.
- A estampa deve parecer IMPRESSA DE VERDADE no tecido: segue dobras e movimento, recebe a mesma luz e sombra da cena e mostra leve textura da trama por baixo da tinta — nunca lisa como vetor digital.
- Peças dobradas ou penduradas têm VOLUME real de tecido — nunca aparência achatada de recorte 2D.

MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.

PROTEÇÃO DE MENORES (regra absoluta, não negociável): há criança ou adolescente em cena. Sempre: roupa apropriada para a idade; nada revelador; nada sexualizado; nenhuma estética adulta (maquiagem, figurino ou pose de adulto); poses naturais e apropriadas à idade; peças com caimento normal, sem foco no corpo; contexto comercial, familiar e cotidiano coerente.

PRODUTOS (autoridade absoluta), 2 produtos DIFERENTES nesta ordem:
  · Produto 1 (imagem 1): "Irmãs em União — Rosa" (camiseta infantil) — camiseta infantil rosa, duas irmãs de mãos dadas
  · Produto 2 (imagem 2): "Irmãs em União — Azul" (camiseta infantil) — camiseta infantil azul, duas irmãs de mãos dadas
  · Cada produto aparece exatamente uma vez; nunca troque, funda ou duplique produtos.

SEMÂNTICA DO PRODUTO (o significado da estampa orienta o clima da cena; não altera a pose, o enquadramento nem a quantidade de pessoas definidos abaixo):
  · "Irmãs em União — Rosa" (camiseta infantil) — tema: irmãos; quem veste: criança; a cena pode remeter a: vínculo, brincar; pessoa de apoio recomendada: irmão ou irmã.
  · "Irmãs em União — Azul" (camiseta infantil) — tema: irmãos; quem veste: criança; a cena pode remeter a: vínculo, brincar; pessoa de apoio recomendada: irmão ou irmã.

COMPOSIÇÃO DE PESSOAS (contrato): exatamente 2 pessoas em quadro.
  · Pessoa 1 (principal): menina 8 anos, criança de 6 a 9 anos — veste "Irmãs em União — Rosa" (camiseta infantil).
  · Pessoa 2 (apoio): menina 5 anos, criança de 3 a 5 anos, irmão ou irmã da Pessoa 1 — veste "Irmãs em União — Azul" (camiseta infantil).

OLHAR: olhar espontâneo para fora da câmera, como se algo fora de quadro chamasse a atenção; ninguém olha diretamente para a lente.

INTERAÇÃO (espontâneo): as pessoas convivem de forma natural e espontânea, lado a lado ou levemente voltadas umas para as outras, sem posar para a câmera. Mãos: mãos relaxadas ao lado do corpo ou apoiadas numa superfície do ambiente; nenhuma mão cruza o corpo de outra pessoa.

ÂNGULO LIFESTYLE COTIDIANO: as pessoas em ação natural no dia a dia, vivendo um momento real — nunca posadas nem paradas olhando para o nada. Cenário: sala de estar acolhedora com sofá, manta e luz natural lateral.

VESTUÁRIO DAS CRIANÇAS (política da marca): pernas totalmente cobertas — preferir calça, jeans, sarja, legging apropriada ou peças compridas; nenhuma composição que exponha demais as pernas; sem shorts curtos; sem saias curtas; roupas casuais infantis, apropriadas à idade.

MARCA (Entre Nós):
  · Posicionamento: camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa.
  · Linguagem visual: editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo, luz natural quente e suave, hora dourada ou luz de janela, materiais tácteis e domésticos: tecidos, madeira, linho, papel.
  · Paleta da marca (guia de cor da CENA, nunca do produto): creme e bege quente; bordô/vinho profundo; marrom terroso; navy; off-white.
  · Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.
  · Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.
  · Crianças em cena sempre à vontade e em interação real com o adulto.

NICHO (Moda / Vestuário):
  · Materiais e sinais de uso real: algodão, trama de tecido visível, costuras e acabamento, etiqueta discreta.
  · Público: compra pelo caimento e pelo estilo, não só pela estampa; quer ver a peça vestida em corpo real; compara tecido, acabamento e tamanho antes de decidir.

CONTEXTO DA CENA: sala de estar acolhedora com sofá, manta e luz natural lateral. Elemento de apoio, discreto: manta de tricô jogada no encosto. Contexto coerente e contemporâneo, sem caricatura nem cenário turístico óbvio.

EVITAR (não incluir na cena, mesmo que outra regra sugira algo parecido): qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado; estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans); clima de propaganda de margarina; cenário de imobiliária sem sinal de uso; peça deformada ou com proporção irreal; tecido liso como vetor, sem trama; produto parecendo adesivo colado na foto.

FORMATO: Feed 4:5 vertical (1080×1350).
```

### FeedbackSnapshot

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "plan_id": "plan_b8d64b39f07767e71f6231a7",
  "plan_schema_version": 2,
  "compiler_version": 2,
  "prompt_version": 2,
  "prompt_sha256": "2c6f03366ded731828d7f32b86eae4c7b6b28e5391dfafca0c8d4c38a58c828a",
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "angle": "LIFESTYLE_COTIDIANO",
  "product_ids": [
    "irmas-rosa",
    "irmas-azul"
  ],
  "subjects": [
    {
      "role": "primary",
      "label": "menina 8 anos",
      "age_band": "child_6_9",
      "is_minor": true,
      "product_use": "wears",
      "role_hint": null,
      "relation_to_primary": null
    },
    {
      "role": "supporting",
      "label": "menina 5 anos",
      "age_band": "child_3_5",
      "is_minor": true,
      "product_use": "wears",
      "role_hint": "sibling",
      "relation_to_primary": "sibling"
    }
  ],
  "people_count": 2,
  "interaction": "candid",
  "composition_source": "explicit",
  "composition_key": "p2|child_6_9+sibling|candid",
  "pose_risk": "low",
  "warnings": [],
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "placement": "FEED_4X5",
  "quality": "medium",
  "gaze_mode": "off_camera",
  "minor_safety_applied": true,
  "flags": {
    "normalize_references": null
  },
  "model": {
    "requested": "gpt-image-2",
    "served": null
  },
  "asset_sha256": null
}
```

### GenerationDraft

```json
{
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "multi_product",
  "product_ids": [
    "irmas-rosa",
    "irmas-azul"
  ],
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "quality": "medium",
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "persona_mode": "automatic",
  "persona": null,
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "persona": {
        "label": "menina 8 anos",
        "age_band": "child_6_9"
      },
      "wears_product_id": "irmas-rosa",
      "prominence": "hero",
      "age_band": "child_6_9"
    },
    {
      "id": "s2",
      "role": "supporting",
      "persona": {
        "label": "menina 5 anos",
        "age_band": "child_3_5"
      },
      "wears_product_id": "irmas-azul",
      "prominence": "secondary",
      "age_band": "child_3_5",
      "relation_to_primary": "sibling"
    }
  ],
  "interaction": "candid",
  "scene_picks": {
    "acao": 4
  },
  "context": {
    "mode": "custom",
    "context_id": "entre_nos_sala",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "funnel_stage": null,
  "remarketing": null,
  "funnel": null,
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "gaze_mode": "off_camera",
  "plan_schema_version": 2,
  "prompt_version": 2,
  "seed": 100,
  "plan_warnings": [],
  "actions": {
    "again": {
      "seed": 100,
      "scene_picks": {
        "acao": 4
      },
      "gaze_mode": "off_camera"
    },
    "variation": {
      "seed": null,
      "scene_picks": null,
      "gaze_mode": "auto"
    }
  },
  "source": {
    "creative_id": "33333333-3333-4333-8333-333333333333",
    "plan_id": "plan_b8d64b39f07767e71f6231a7",
    "plan_schema_version": 2,
    "compiler_version": 2
  },
  "carried": [
    "mode",
    "objective",
    "product_ids",
    "angle_id",
    "placement_id",
    "quality",
    "brand_kit",
    "niche_kit",
    "subjects",
    "interaction",
    "context",
    "copy",
    "gaze_mode",
    "scene_picks",
    "seed"
  ]
}
```

## Caso D — Casal, duas pessoas adultas com peças combinando

### Request

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "multi_product",
  "products": [
    {
      "id": "casal-ele",
      "name": "Casal — Ele",
      "type": "camiseta",
      "description": "camiseta adulta lisa com pequena estampa no peito",
      "referenceImages": [
        "tenant-demo/products/casal-ele/front.webp"
      ]
    },
    {
      "id": "casal-ela",
      "name": "Casal — Ela",
      "type": "camiseta",
      "description": "camiseta adulta lisa com pequena estampa no peito, par do modelo Ele",
      "referenceImages": [
        "tenant-demo/products/casal-ela/front.webp"
      ]
    }
  ],
  "brand_kit": {
    "id": "entre_nos_ab",
    "name": "Entre Nós",
    "schemaVersion": 1,
    "version": 1,
    "positioning": [
      "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
    ],
    "visualStyle": [
      "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
      "luz natural quente e suave, hora dourada ou luz de janela",
      "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
    ],
    "colors": [
      "creme e bege quente",
      "bordô/vinho profundo",
      "marrom terroso",
      "navy",
      "off-white"
    ],
    "manualNotes": [
      "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
      "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
      "Crianças em cena sempre à vontade e em interação real com o adulto."
    ],
    "avoid": [
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso"
    ],
    "suggestedPersonas": [
      {
        "label": "menina 6 anos",
        "source": "automatic"
      },
      {
        "label": "mulher 35 anos, mãe da menina",
        "source": "automatic"
      }
    ],
    "minorWardrobePolicy": {
      "enabled": true,
      "legs_coverage": "full",
      "allow_short_shorts": false,
      "allow_short_skirts": false,
      "allow_revealing_clothing": false,
      "style": "casual_age_appropriate"
    }
  },
  "niche_kit_id": "fashion",
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "persona_mode": "automatic",
  "context": {
    "mode": "custom",
    "profile": {
      "contextId": "entre_nos_sala",
      "contextType": "custom",
      "subject": {
        "name": "Sala de estar acolhedora"
      },
      "summary": "Rotina dentro de casa",
      "sceneContexts": [
        "sala de estar acolhedora com sofá, manta e luz natural lateral"
      ],
      "domainElements": [
        "manta de tricô jogada no encosto"
      ],
      "avoid": [
        "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado"
      ],
      "status": "approved",
      "schemaVersion": 1,
      "promptVersion": 1,
      "profileVersion": 1
    }
  },
  "quality": "medium",
  "seed": 100,
  "plan_schema_version": 2,
  "prompt_version": 2,
  "subjects": [
    {
      "id": "ela",
      "role": "primary",
      "persona": {
        "label": "mulher 32 anos",
        "age_band": "adult"
      },
      "wears_product_id": "casal-ela"
    },
    {
      "id": "ele",
      "role": "supporting",
      "persona": {
        "label": "homem 34 anos",
        "age_band": "adult"
      },
      "relation_to_primary": "partner",
      "wears_product_id": "casal-ele"
    }
  ],
  "interaction": "looking_at_each_other"
}
```

### CreativePlan

```json
{
  "plan_id": "plan_e0e7ed633fd11c59ca827f1d",
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "schema_version": 2,
  "strategy": "CLEAN_ANGLES",
  "internal_strategy_id": "ANGULOS_LIMPOS",
  "product_mode": "multi_product",
  "products": [
    {
      "id": "casal-ele",
      "name": "Casal — Ele",
      "type": "camiseta"
    },
    {
      "id": "casal-ela",
      "name": "Casal — Ela",
      "type": "camiseta"
    }
  ],
  "angle": {
    "id": "LIFESTYLE_COTIDIANO",
    "label": "Lifestyle cotidiano",
    "description": "Pessoa em ação no dia a dia com o produto — nunca parada olhando para o nada.",
    "uses_person": true,
    "apparel_only": false,
    "multi_product_limit": 4
  },
  "placement": {
    "id": "FEED_4X5",
    "label": "Feed (4:5 — 1080×1350)",
    "width": 1080,
    "height": 1350,
    "api_size": "1088x1360"
  },
  "persona": {
    "label": "mulher 32 anos",
    "age_band": "adult"
  },
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral",
    "supporting_element": "manta de tricô jogada no encosto",
    "avoid": [
      "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado",
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso",
      "peça deformada ou com proporção irreal",
      "tecido liso como vetor, sem trama",
      "produto parecendo adesivo colado na foto"
    ],
    "status": "approved",
    "profile_version": 1
  },
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "funnel_stage": null,
  "remarketing_intent": null,
  "layout": null,
  "overlay": {
    "allowed": false,
    "headline": null,
    "subheadline": null,
    "cta": null,
    "badges": [],
    "benefits": [],
    "search_bar_text": null,
    "chips": [],
    "text_density": null,
    "cta_emphasis": null,
    "clean": true
  },
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "prompt": {
    "text": "<4838 caracteres; ver abaixo>",
    "sections": [
      {
        "name": "fidelity_rules",
        "length": 1369,
        "source": "product",
        "value": "8"
      },
      {
        "name": "text_rules",
        "length": 509,
        "source": "user",
        "value": "clean_creative"
      },
      {
        "name": "reference_roles",
        "length": 378,
        "source": "product",
        "value": "refs:2"
      },
      {
        "name": "people_composition_contract",
        "length": 244,
        "source": "user",
        "value": "2"
      },
      {
        "name": "gaze",
        "length": 85,
        "source": "planner_default",
        "value": "interaction"
      },
      {
        "name": "interaction",
        "length": 152,
        "source": "user",
        "value": "looking_at_each_other"
      },
      {
        "name": "scene_action",
        "length": 214,
        "source": "angle",
        "value": "LIFESTYLE_COTIDIANO"
      },
      {
        "name": "brand",
        "length": 827,
        "source": "brand",
        "value": "Entre Nós"
      },
      {
        "name": "niche",
        "length": 301,
        "source": "niche",
        "value": "Moda / Vestuário"
      },
      {
        "name": "context",
        "length": 223,
        "source": "user",
        "value": "entre_nos_sala"
      },
      {
        "name": "avoid",
        "length": 475,
        "source": "brand",
        "value": "7"
      },
      {
        "name": "output_format",
        "length": 39,
        "source": "user",
        "value": "FEED_4X5"
      }
    ],
    "sha256": "f990b0a2e6d401fbec9d1618f3572aaa84116853f65077579a87b619b815a9a3",
    "prompt_version": 2
  },
  "model": {
    "task": "image_generation",
    "model": "gpt-image-2",
    "quality": "medium",
    "size": "1088x1360"
  },
  "mode": "creative",
  "objective": "clean_creative",
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "label": "mulher 32 anos",
      "persona": {
        "label": "mulher 32 anos",
        "age_band": "adult"
      },
      "age_band": "adult",
      "is_minor": false,
      "age_source": "persona.age_band",
      "minor_source": null,
      "product_use": "wears",
      "product_id": "casal-ela",
      "role_hint": null,
      "relation_to_primary": null,
      "relation_label": null,
      "prominence": "hero",
      "source": "user"
    },
    {
      "id": "s2",
      "role": "supporting",
      "label": "homem 34 anos",
      "persona": {
        "label": "homem 34 anos",
        "age_band": "adult"
      },
      "age_band": "adult",
      "is_minor": false,
      "age_source": "persona.age_band",
      "minor_source": null,
      "product_use": "wears",
      "product_id": "casal-ele",
      "role_hint": "partner",
      "relation_to_primary": "partner",
      "relation_label": null,
      "prominence": "secondary",
      "source": "user"
    }
  ],
  "scene": {
    "gaze": {
      "mode": "interaction",
      "requested": "auto",
      "source": "planner_default",
      "reason": "interaction:looking_at_each_other"
    },
    "picks": {
      "acao": {
        "index": 4,
        "text": "chegando a um ambiente, cruzando a entrada com os braços soltos ao lado do corpo"
      }
    },
    "prompt_version": 2,
    "interaction": "looking_at_each_other",
    "interaction_detail": {
      "id": "looking_at_each_other",
      "catalog_version": 1,
      "label": "olhando uma para a outra",
      "min_people": 2,
      "max_people": 2,
      "excluded_bands": [],
      "contact": "none",
      "hand_complexity": 0,
      "object_use": "none",
      "gaze_default": "interaction",
      "pose_risk": 0,
      "scene": "olham uma para a outra com expressão calorosa, próximas mas sem se abraçar.",
      "hands": "mãos relaxadas ao lado do corpo."
    },
    "interaction_source": "user",
    "scene_mode": "frame",
    "composition_source": "explicit"
  },
  "composition": {
    "people_count": 2,
    "pose_risk": "low",
    "risk_reasons": [
      "people:2"
    ]
  },
  "minor_safety": {
    "applies": false,
    "minor_subject_ids": [],
    "global": {
      "policy": "global_minor_safety_policy",
      "version": 1,
      "rules": [
        "age_appropriate_clothing",
        "nothing_revealing",
        "not_sexualized",
        "no_adult_aesthetic",
        "age_appropriate_poses",
        "normal_fit_no_body_focus",
        "commercial_family_context"
      ],
      "adult_child_rule": null
    },
    "brand": null,
    "basis": {
      "explicit": [],
      "heuristic": []
    }
  },
  "semantics": {
    "products": [
      {
        "product_id": "casal-ele",
        "semantic_context": null
      },
      {
        "product_id": "casal-ela",
        "semantic_context": null
      }
    ],
    "supporting": null,
    "warnings": []
  },
  "resolved_inputs": {
    "brand": {
      "name": "Entre Nós",
      "positioning": [
        "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
      ],
      "visualStyle": [
        "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
        "luz natural quente e suave, hora dourada ou luz de janela",
        "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
      ],
      "colors": [
        "creme e bege quente",
        "bordô/vinho profundo",
        "marrom terroso",
        "navy",
        "off-white"
      ],
      "manualNotes": [
        "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
        "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
        "Crianças em cena sempre à vontade e em interação real com o adulto."
      ]
    },
    "niche": {
      "name": "Moda / Vestuário",
      "materials": [
        "algodão",
        "trama de tecido visível",
        "costuras e acabamento",
        "etiqueta discreta"
      ],
      "audienceBehaviors": [
        "compra pelo caimento e pelo estilo, não só pela estampa",
        "quer ver a peça vestida em corpo real",
        "compara tecido, acabamento e tamanho antes de decidir"
      ]
    },
    "strategy": {
      "text_rule": "MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.",
      "communication": ""
    }
  },
  "provenance": {
    "angle": "user",
    "brand_kit": "user",
    "compiler": "planner_default",
    "composition": "planner_default",
    "context": "user",
    "minor_safety.brand": "planner_default",
    "minor_safety.global": "safety_policy",
    "mode": "planner_default",
    "model": "planner_default",
    "niche_kit": "user",
    "objective": "user",
    "persona": "brand",
    "placement": "user",
    "products": "user",
    "quality": "user",
    "references": "product",
    "resolved_inputs": "brand",
    "scene": "mixed",
    "scene.gaze": "planner_default",
    "scene.interaction": "user",
    "scene.picks": "planner_default",
    "scene.prompt_version": "planner_default",
    "semantics": "planner_default",
    "strategy": "user",
    "subjects": "user",
    "subjects.s1": "user",
    "subjects.s1.age_band": "persona",
    "subjects.s2": "user",
    "subjects.s2.age_band": "persona"
  },
  "provenance_sources": {
    "scene": [
      "planner_default",
      "user"
    ],
    "subjects": [
      "user"
    ]
  },
  "seed": 100,
  "compiler": {
    "version": 2,
    "sections": [
      {
        "section": "fidelity_rules",
        "source": "product",
        "length": 1369
      },
      {
        "section": "text_rules",
        "source": "user",
        "length": 509
      },
      {
        "section": "reference_roles",
        "source": "product",
        "length": 378
      },
      {
        "section": "people_composition_contract",
        "source": "user",
        "length": 244
      },
      {
        "section": "gaze",
        "source": "planner_default",
        "length": 85
      },
      {
        "section": "interaction",
        "source": "user",
        "length": 152
      },
      {
        "section": "scene_action",
        "source": "angle",
        "length": 214
      },
      {
        "section": "brand",
        "source": "brand",
        "length": 827
      },
      {
        "section": "niche",
        "source": "niche",
        "length": 301
      },
      {
        "section": "context",
        "source": "user",
        "length": 223
      },
      {
        "section": "avoid",
        "source": "brand",
        "length": 475
      },
      {
        "section": "output_format",
        "source": "user",
        "length": 39
      }
    ]
  },
  "versions": {
    "core_version": "1.1.0",
    "schema_version": 1,
    "prompt_version": 2,
    "brand_kit_schema_version": 1,
    "niche_kit_schema_version": 1,
    "context_profile_schema_version": 1,
    "clean_angles_version": 1,
    "remarketing_version": 1,
    "funnel_visual_version": 1,
    "strategy_version": 1,
    "compiler_version": 2,
    "brand_kit_version": 1,
    "niche_kit_version": 1,
    "context_profile_version": 1
  },
  "validations": [
    {
      "rule": "product_count_within_limits",
      "passed": true
    },
    {
      "rule": "angle_available_for_brand_and_niche",
      "passed": true
    },
    {
      "rule": "context_profile_approved",
      "passed": true
    },
    {
      "rule": "references_are_product_art_only",
      "passed": true
    },
    {
      "rule": "clean_angles_has_no_overlay",
      "passed": true
    }
  ],
  "warnings": []
}
```

### Prompt compilado

```text
REGRAS OBRIGATÓRIAS (nunca ignore):
- Preserve 100% o(s) produto(s) das imagens de referência — forma, cores, materiais, detalhes, estampas e textos originais idênticos; nunca invente, troque, duplique ou funda produtos.
- O produto deve parecer fotografado de verdade na cena: mesma luz, sombra, temperatura de cor e perspectiva do ambiente, textura real do material — nunca recortado ou colado como adesivo.
- Sem logotipos de terceiros, marca d'água, arroba de rede social ou endereço de site.
- Sem urgência falsa ("Só hoje", "Estoque limitado") e sem prova social fabricada (depoimento, nota, estrelas, número de clientes).
- Fotografia realista, alta qualidade, formato vertical.
- Preserve o TIPO DE PEÇA original: camiseta de MANGA CURTA, gola redonda, tecido de algodão comum (não premium). NUNCA transforme em manga longa, moletom, camisa de botão ou qualquer outra peça — mesmo que o cenário sugira frio, a peça continua sendo camiseta de manga curta (a pessoa pode usar um casaco/jaqueta POR CIMA se o clima pedir, mas a camiseta em si nunca muda de manga).
- A estampa deve parecer IMPRESSA DE VERDADE no tecido: segue dobras e movimento, recebe a mesma luz e sombra da cena e mostra leve textura da trama por baixo da tinta — nunca lisa como vetor digital.
- Peças dobradas ou penduradas têm VOLUME real de tecido — nunca aparência achatada de recorte 2D.

MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.

PRODUTOS (autoridade absoluta), 2 produtos DIFERENTES nesta ordem:
  · Produto 1 (imagem 1): "Casal — Ele" (camiseta) — camiseta adulta lisa com pequena estampa no peito
  · Produto 2 (imagem 2): "Casal — Ela" (camiseta) — camiseta adulta lisa com pequena estampa no peito, par do modelo Ele
  · Cada produto aparece exatamente uma vez; nunca troque, funda ou duplique produtos.

COMPOSIÇÃO DE PESSOAS (contrato): exatamente 2 pessoas em quadro.
  · Pessoa 1 (principal): mulher 32 anos — veste "Casal — Ela" (camiseta).
  · Pessoa 2 (apoio): homem 34 anos, parceiro ou parceira da Pessoa 1 — veste "Casal — Ele" (camiseta).

OLHAR: as pessoas olham uma para a outra ou para a ação em curso — não para a câmera.

INTERAÇÃO (olhando uma para a outra): olham uma para a outra com expressão calorosa, próximas mas sem se abraçar. Mãos: mãos relaxadas ao lado do corpo.

ÂNGULO LIFESTYLE COTIDIANO: as pessoas em ação natural no dia a dia, vivendo um momento real — nunca posadas nem paradas olhando para o nada. Cenário: sala de estar acolhedora com sofá, manta e luz natural lateral.

MARCA (Entre Nós):
  · Posicionamento: camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa.
  · Linguagem visual: editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo, luz natural quente e suave, hora dourada ou luz de janela, materiais tácteis e domésticos: tecidos, madeira, linho, papel.
  · Paleta da marca (guia de cor da CENA, nunca do produto): creme e bege quente; bordô/vinho profundo; marrom terroso; navy; off-white.
  · Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.
  · Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.
  · Crianças em cena sempre à vontade e em interação real com o adulto.

NICHO (Moda / Vestuário):
  · Materiais e sinais de uso real: algodão, trama de tecido visível, costuras e acabamento, etiqueta discreta.
  · Público: compra pelo caimento e pelo estilo, não só pela estampa; quer ver a peça vestida em corpo real; compara tecido, acabamento e tamanho antes de decidir.

CONTEXTO DA CENA: sala de estar acolhedora com sofá, manta e luz natural lateral. Elemento de apoio, discreto: manta de tricô jogada no encosto. Contexto coerente e contemporâneo, sem caricatura nem cenário turístico óbvio.

EVITAR (não incluir na cena, mesmo que outra regra sugira algo parecido): qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado; estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans); clima de propaganda de margarina; cenário de imobiliária sem sinal de uso; peça deformada ou com proporção irreal; tecido liso como vetor, sem trama; produto parecendo adesivo colado na foto.

FORMATO: Feed 4:5 vertical (1080×1350).
```

### FeedbackSnapshot

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "plan_id": "plan_e0e7ed633fd11c59ca827f1d",
  "plan_schema_version": 2,
  "compiler_version": 2,
  "prompt_version": 2,
  "prompt_sha256": "f990b0a2e6d401fbec9d1618f3572aaa84116853f65077579a87b619b815a9a3",
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "angle": "LIFESTYLE_COTIDIANO",
  "product_ids": [
    "casal-ele",
    "casal-ela"
  ],
  "subjects": [
    {
      "role": "primary",
      "label": "mulher 32 anos",
      "age_band": "adult",
      "is_minor": false,
      "product_use": "wears",
      "role_hint": null,
      "relation_to_primary": null
    },
    {
      "role": "supporting",
      "label": "homem 34 anos",
      "age_band": "adult",
      "is_minor": false,
      "product_use": "wears",
      "role_hint": "partner",
      "relation_to_primary": "partner"
    }
  ],
  "people_count": 2,
  "interaction": "looking_at_each_other",
  "composition_source": "explicit",
  "composition_key": "p2|adult+partner|looking_at_each_other",
  "pose_risk": "low",
  "warnings": [],
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "placement": "FEED_4X5",
  "quality": "medium",
  "gaze_mode": "interaction",
  "minor_safety_applied": false,
  "flags": {
    "normalize_references": null
  },
  "model": {
    "requested": "gpt-image-2",
    "served": null
  },
  "asset_sha256": null
}
```

### GenerationDraft

```json
{
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "multi_product",
  "product_ids": [
    "casal-ele",
    "casal-ela"
  ],
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "quality": "medium",
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "persona_mode": "automatic",
  "persona": null,
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "persona": {
        "label": "mulher 32 anos",
        "age_band": "adult"
      },
      "wears_product_id": "casal-ela",
      "prominence": "hero",
      "age_band": "adult"
    },
    {
      "id": "s2",
      "role": "supporting",
      "persona": {
        "label": "homem 34 anos",
        "age_band": "adult"
      },
      "wears_product_id": "casal-ele",
      "prominence": "secondary",
      "age_band": "adult",
      "relation_to_primary": "partner"
    }
  ],
  "interaction": "looking_at_each_other",
  "scene_picks": {
    "acao": 4
  },
  "context": {
    "mode": "custom",
    "context_id": "entre_nos_sala",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "funnel_stage": null,
  "remarketing": null,
  "funnel": null,
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "gaze_mode": "interaction",
  "plan_schema_version": 2,
  "prompt_version": 2,
  "seed": 100,
  "plan_warnings": [],
  "actions": {
    "again": {
      "seed": 100,
      "scene_picks": {
        "acao": 4
      },
      "gaze_mode": "interaction"
    },
    "variation": {
      "seed": null,
      "scene_picks": null,
      "gaze_mode": "auto"
    }
  },
  "source": {
    "creative_id": "33333333-3333-4333-8333-333333333333",
    "plan_id": "plan_e0e7ed633fd11c59ca827f1d",
    "plan_schema_version": 2,
    "compiler_version": 2
  },
  "carried": [
    "mode",
    "objective",
    "product_ids",
    "angle_id",
    "placement_id",
    "quality",
    "brand_kit",
    "niche_kit",
    "subjects",
    "interaction",
    "context",
    "copy",
    "gaze_mode",
    "scene_picks",
    "seed"
  ]
}
```

## Caso E — Família de 4: aviso, risco alto e pose simples

### Request

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "multi_product",
  "products": [
    {
      "id": "familia-crianca1",
      "name": "Família Entre Nós — Criança 1",
      "type": "camiseta infantil",
      "description": "camiseta infantil com estampa de família de ursinhos",
      "referenceImages": [
        "tenant-demo/products/familia-crianca1/front.webp"
      ]
    },
    {
      "id": "familia-crianca2",
      "name": "Família Entre Nós — Criança 2",
      "type": "camiseta infantil",
      "description": "camiseta infantil com estampa de família de ursinhos, variação",
      "referenceImages": [
        "tenant-demo/products/familia-crianca2/front.webp"
      ]
    }
  ],
  "brand_kit": {
    "id": "entre_nos_ab",
    "name": "Entre Nós",
    "schemaVersion": 1,
    "version": 1,
    "positioning": [
      "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
    ],
    "visualStyle": [
      "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
      "luz natural quente e suave, hora dourada ou luz de janela",
      "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
    ],
    "colors": [
      "creme e bege quente",
      "bordô/vinho profundo",
      "marrom terroso",
      "navy",
      "off-white"
    ],
    "manualNotes": [
      "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
      "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
      "Crianças em cena sempre à vontade e em interação real com o adulto."
    ],
    "avoid": [
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso"
    ],
    "suggestedPersonas": [
      {
        "label": "menina 6 anos",
        "source": "automatic"
      },
      {
        "label": "mulher 35 anos, mãe da menina",
        "source": "automatic"
      }
    ],
    "minorWardrobePolicy": {
      "enabled": true,
      "legs_coverage": "full",
      "allow_short_shorts": false,
      "allow_short_skirts": false,
      "allow_revealing_clothing": false,
      "style": "casual_age_appropriate"
    }
  },
  "niche_kit_id": "fashion",
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "persona_mode": "automatic",
  "context": {
    "mode": "custom",
    "profile": {
      "contextId": "entre_nos_sala",
      "contextType": "custom",
      "subject": {
        "name": "Sala de estar acolhedora"
      },
      "summary": "Rotina dentro de casa",
      "sceneContexts": [
        "sala de estar acolhedora com sofá, manta e luz natural lateral"
      ],
      "domainElements": [
        "manta de tricô jogada no encosto"
      ],
      "avoid": [
        "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado"
      ],
      "status": "approved",
      "schemaVersion": 1,
      "promptVersion": 1,
      "profileVersion": 1
    }
  },
  "quality": "medium",
  "seed": 100,
  "plan_schema_version": 2,
  "prompt_version": 2,
  "subjects": [
    {
      "id": "crianca1",
      "role": "primary",
      "persona": {
        "label": "menino 8 anos",
        "age_band": "child_6_9"
      },
      "wears_product_id": "familia-crianca1"
    },
    {
      "id": "crianca2",
      "role": "supporting",
      "persona": {
        "label": "menina 5 anos",
        "age_band": "child_3_5"
      },
      "relation_to_primary": "sibling",
      "wears_product_id": "familia-crianca2"
    },
    {
      "id": "mae",
      "role": "supporting",
      "persona": {
        "label": "mulher 36 anos",
        "age_band": "adult"
      },
      "relation_to_primary": "mother",
      "wears_product_id": null
    },
    {
      "id": "pai",
      "role": "supporting",
      "persona": {
        "label": "homem 38 anos",
        "age_band": "adult"
      },
      "relation_to_primary": "father",
      "wears_product_id": null
    }
  ],
  "interaction": "group_photo"
}
```

### CreativePlan

```json
{
  "plan_id": "plan_550a8363314ab5357e46e066",
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "schema_version": 2,
  "strategy": "CLEAN_ANGLES",
  "internal_strategy_id": "ANGULOS_LIMPOS",
  "product_mode": "multi_product",
  "products": [
    {
      "id": "familia-crianca1",
      "name": "Família Entre Nós — Criança 1",
      "type": "camiseta infantil"
    },
    {
      "id": "familia-crianca2",
      "name": "Família Entre Nós — Criança 2",
      "type": "camiseta infantil"
    }
  ],
  "angle": {
    "id": "LIFESTYLE_COTIDIANO",
    "label": "Lifestyle cotidiano",
    "description": "Pessoa em ação no dia a dia com o produto — nunca parada olhando para o nada.",
    "uses_person": true,
    "apparel_only": false,
    "multi_product_limit": 4
  },
  "placement": {
    "id": "FEED_4X5",
    "label": "Feed (4:5 — 1080×1350)",
    "width": 1080,
    "height": 1350,
    "api_size": "1088x1360"
  },
  "persona": {
    "label": "menino 8 anos",
    "age_band": "child_6_9"
  },
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral",
    "supporting_element": "manta de tricô jogada no encosto",
    "avoid": [
      "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado",
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso",
      "peça deformada ou com proporção irreal",
      "tecido liso como vetor, sem trama",
      "produto parecendo adesivo colado na foto"
    ],
    "status": "approved",
    "profile_version": 1
  },
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "funnel_stage": null,
  "remarketing_intent": null,
  "layout": null,
  "overlay": {
    "allowed": false,
    "headline": null,
    "subheadline": null,
    "cta": null,
    "badges": [],
    "benefits": [],
    "search_bar_text": null,
    "chips": [],
    "text_density": null,
    "cta_emphasis": null,
    "clean": true
  },
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "prompt": {
    "text": "<5945 caracteres; ver abaixo>",
    "sections": [
      {
        "name": "fidelity_rules",
        "length": 1301,
        "source": "product",
        "value": "8"
      },
      {
        "name": "text_rules",
        "length": 509,
        "source": "user",
        "value": "clean_creative"
      },
      {
        "name": "minor_safety",
        "length": 474,
        "source": "safety_policy",
        "value": "minors:s1,s2"
      },
      {
        "name": "reference_roles",
        "length": 429,
        "source": "product",
        "value": "refs:2"
      },
      {
        "name": "people_composition_contract",
        "length": 485,
        "source": "user",
        "value": "4"
      },
      {
        "name": "gaze",
        "length": 73,
        "source": "planner_default",
        "value": "camera"
      },
      {
        "name": "interaction",
        "length": 296,
        "source": "user",
        "value": "group_photo"
      },
      {
        "name": "scene_action",
        "length": 214,
        "source": "angle",
        "value": "LIFESTYLE_COTIDIANO"
      },
      {
        "name": "minor_wardrobe_policy",
        "length": 273,
        "source": "brand",
        "value": "full"
      },
      {
        "name": "brand",
        "length": 827,
        "source": "brand",
        "value": "Entre Nós"
      },
      {
        "name": "niche",
        "length": 301,
        "source": "niche",
        "value": "Moda / Vestuário"
      },
      {
        "name": "context",
        "length": 223,
        "source": "user",
        "value": "entre_nos_sala"
      },
      {
        "name": "avoid",
        "length": 475,
        "source": "brand",
        "value": "7"
      },
      {
        "name": "output_format",
        "length": 39,
        "source": "user",
        "value": "FEED_4X5"
      }
    ],
    "sha256": "7ff0cac79c7b87e7479b7ef734a19a6bf3f82d0c23cf93d9ec17332d9a9628d7",
    "prompt_version": 2
  },
  "model": {
    "task": "image_generation",
    "model": "gpt-image-2",
    "quality": "medium",
    "size": "1088x1360"
  },
  "mode": "creative",
  "objective": "clean_creative",
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "label": "menino 8 anos",
      "persona": {
        "label": "menino 8 anos",
        "age_band": "child_6_9"
      },
      "age_band": "child_6_9",
      "is_minor": true,
      "age_source": "persona.age_band",
      "minor_source": "persona.age_band",
      "product_use": "wears",
      "product_id": "familia-crianca1",
      "role_hint": null,
      "relation_to_primary": null,
      "relation_label": null,
      "prominence": "hero",
      "source": "user"
    },
    {
      "id": "s2",
      "role": "supporting",
      "label": "menina 5 anos",
      "persona": {
        "label": "menina 5 anos",
        "age_band": "child_3_5"
      },
      "age_band": "child_3_5",
      "is_minor": true,
      "age_source": "persona.age_band",
      "minor_source": "persona.age_band",
      "product_use": "wears",
      "product_id": "familia-crianca2",
      "role_hint": "sibling",
      "relation_to_primary": "sibling",
      "relation_label": null,
      "prominence": "secondary",
      "source": "user"
    },
    {
      "id": "s3",
      "role": "supporting",
      "label": "mulher 36 anos",
      "persona": {
        "label": "mulher 36 anos",
        "age_band": "adult"
      },
      "age_band": "adult",
      "is_minor": false,
      "age_source": "persona.age_band",
      "minor_source": null,
      "product_use": "none",
      "product_id": null,
      "role_hint": "mother",
      "relation_to_primary": "mother",
      "relation_label": null,
      "prominence": "secondary",
      "source": "user"
    },
    {
      "id": "s4",
      "role": "supporting",
      "label": "homem 38 anos",
      "persona": {
        "label": "homem 38 anos",
        "age_band": "adult"
      },
      "age_band": "adult",
      "is_minor": false,
      "age_source": "persona.age_band",
      "minor_source": null,
      "product_use": "none",
      "product_id": null,
      "role_hint": "father",
      "relation_to_primary": "father",
      "relation_label": null,
      "prominence": "secondary",
      "source": "user"
    }
  ],
  "scene": {
    "gaze": {
      "mode": "camera",
      "requested": "auto",
      "source": "planner_default",
      "reason": "interaction:group_photo"
    },
    "picks": {
      "acao": {
        "index": 4,
        "text": "chegando a um ambiente, cruzando a entrada com os braços soltos ao lado do corpo"
      }
    },
    "prompt_version": 2,
    "interaction": "group_photo",
    "interaction_detail": {
      "id": "group_photo",
      "catalog_version": 1,
      "label": "foto de grupo",
      "min_people": 3,
      "max_people": 4,
      "excluded_bands": [],
      "contact": "light",
      "hand_complexity": 1,
      "object_use": "none",
      "gaze_default": "camera",
      "pose_risk": 1,
      "scene": "reúnem-se para uma foto de grupo espontânea, próximos uns dos outros, em alturas naturais (adultos em pé, crianças à frente), sem pose de estúdio.",
      "hands": "ombros próximos, braços soltos ao lado do corpo ou em volta dos ombros de quem está ao lado; ninguém segura objetos."
    },
    "interaction_source": "user",
    "scene_mode": "frame",
    "composition_source": "explicit"
  },
  "composition": {
    "people_count": 4,
    "pose_risk": "high",
    "risk_reasons": [
      "people:4",
      "interaction:group_photo"
    ]
  },
  "minor_safety": {
    "applies": true,
    "minor_subject_ids": [
      "s1",
      "s2"
    ],
    "global": {
      "policy": "global_minor_safety_policy",
      "version": 1,
      "rules": [
        "age_appropriate_clothing",
        "nothing_revealing",
        "not_sexualized",
        "no_adult_aesthetic",
        "age_appropriate_poses",
        "normal_fit_no_body_focus",
        "commercial_family_context"
      ],
      "adult_child_rule": "adult_child_contact_family_only"
    },
    "brand": {
      "policy": "brand_minor_wardrobe_policy",
      "source": "brand",
      "requested": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "effective": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "ignored": []
    },
    "basis": {
      "explicit": [
        "s1",
        "s2"
      ],
      "heuristic": []
    }
  },
  "semantics": {
    "products": [
      {
        "product_id": "familia-crianca1",
        "semantic_context": null
      },
      {
        "product_id": "familia-crianca2",
        "semantic_context": null
      }
    ],
    "supporting": null,
    "warnings": []
  },
  "resolved_inputs": {
    "brand": {
      "name": "Entre Nós",
      "positioning": [
        "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
      ],
      "visualStyle": [
        "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
        "luz natural quente e suave, hora dourada ou luz de janela",
        "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
      ],
      "colors": [
        "creme e bege quente",
        "bordô/vinho profundo",
        "marrom terroso",
        "navy",
        "off-white"
      ],
      "manualNotes": [
        "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
        "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
        "Crianças em cena sempre à vontade e em interação real com o adulto."
      ]
    },
    "niche": {
      "name": "Moda / Vestuário",
      "materials": [
        "algodão",
        "trama de tecido visível",
        "costuras e acabamento",
        "etiqueta discreta"
      ],
      "audienceBehaviors": [
        "compra pelo caimento e pelo estilo, não só pela estampa",
        "quer ver a peça vestida em corpo real",
        "compara tecido, acabamento e tamanho antes de decidir"
      ]
    },
    "strategy": {
      "text_rule": "MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.",
      "communication": ""
    }
  },
  "provenance": {
    "angle": "user",
    "brand_kit": "user",
    "compiler": "planner_default",
    "composition": "planner_default",
    "context": "user",
    "minor_safety.brand": "brand",
    "minor_safety.global": "safety_policy",
    "mode": "planner_default",
    "model": "planner_default",
    "niche_kit": "user",
    "objective": "user",
    "persona": "brand",
    "placement": "user",
    "products": "user",
    "quality": "user",
    "references": "product",
    "resolved_inputs": "brand",
    "scene": "mixed",
    "scene.gaze": "planner_default",
    "scene.interaction": "user",
    "scene.picks": "planner_default",
    "scene.prompt_version": "planner_default",
    "semantics": "planner_default",
    "strategy": "user",
    "subjects": "user",
    "subjects.s1": "user",
    "subjects.s1.age_band": "persona",
    "subjects.s2": "user",
    "subjects.s2.age_band": "persona",
    "subjects.s3": "user",
    "subjects.s3.age_band": "persona",
    "subjects.s4": "user",
    "subjects.s4.age_band": "persona"
  },
  "provenance_sources": {
    "scene": [
      "planner_default",
      "user"
    ],
    "subjects": [
      "user"
    ]
  },
  "seed": 100,
  "compiler": {
    "version": 2,
    "sections": [
      {
        "section": "fidelity_rules",
        "source": "product",
        "length": 1301
      },
      {
        "section": "text_rules",
        "source": "user",
        "length": 509
      },
      {
        "section": "minor_safety",
        "source": "safety_policy",
        "length": 474
      },
      {
        "section": "reference_roles",
        "source": "product",
        "length": 429
      },
      {
        "section": "people_composition_contract",
        "source": "user",
        "length": 485
      },
      {
        "section": "gaze",
        "source": "planner_default",
        "length": 73
      },
      {
        "section": "interaction",
        "source": "user",
        "length": 296
      },
      {
        "section": "scene_action",
        "source": "angle",
        "length": 214
      },
      {
        "section": "minor_wardrobe_policy",
        "source": "brand",
        "length": 273
      },
      {
        "section": "brand",
        "source": "brand",
        "length": 827
      },
      {
        "section": "niche",
        "source": "niche",
        "length": 301
      },
      {
        "section": "context",
        "source": "user",
        "length": 223
      },
      {
        "section": "avoid",
        "source": "brand",
        "length": 475
      },
      {
        "section": "output_format",
        "source": "user",
        "length": 39
      }
    ]
  },
  "versions": {
    "core_version": "1.1.0",
    "schema_version": 1,
    "prompt_version": 2,
    "brand_kit_schema_version": 1,
    "niche_kit_schema_version": 1,
    "context_profile_schema_version": 1,
    "clean_angles_version": 1,
    "remarketing_version": 1,
    "funnel_visual_version": 1,
    "strategy_version": 1,
    "compiler_version": 2,
    "brand_kit_version": 1,
    "niche_kit_version": 1,
    "context_profile_version": 1
  },
  "validations": [
    {
      "rule": "product_count_within_limits",
      "passed": true
    },
    {
      "rule": "angle_available_for_brand_and_niche",
      "passed": true
    },
    {
      "rule": "context_profile_approved",
      "passed": true
    },
    {
      "rule": "references_are_product_art_only",
      "passed": true
    },
    {
      "rule": "clean_angles_has_no_overlay",
      "passed": true
    }
  ],
  "warnings": [
    "people_count_risk:4"
  ]
}
```

### Prompt compilado

```text
REGRAS OBRIGATÓRIAS (nunca ignore):
- Preserve 100% o(s) produto(s) das imagens de referência — forma, cores, materiais, detalhes, estampas e textos originais idênticos; nunca invente, troque, duplique ou funda produtos.
- O produto deve parecer fotografado de verdade na cena: mesma luz, sombra, temperatura de cor e perspectiva do ambiente, textura real do material — nunca recortado ou colado como adesivo.
- Sem logotipos de terceiros, marca d'água, arroba de rede social ou endereço de site.
- Sem urgência falsa ("Só hoje", "Estoque limitado") e sem prova social fabricada (depoimento, nota, estrelas, número de clientes).
- Fotografia realista, alta qualidade, formato vertical.
- Preserve o TIPO DE PEÇA original: camiseta infantil, manga curta, gola redonda, tamanho de criança. O MODELO da cena é SEMPRE uma criança, NUNCA um adulto. Elementos culturais de adulto (ex: cuia de mate) NÃO devem ficar nas mãos da criança — podem aparecer só discretamente no cenário ao fundo, se fizer sentido.
- A estampa deve parecer IMPRESSA DE VERDADE no tecido: segue dobras e movimento, recebe a mesma luz e sombra da cena e mostra leve textura da trama por baixo da tinta — nunca lisa como vetor digital.
- Peças dobradas ou penduradas têm VOLUME real de tecido — nunca aparência achatada de recorte 2D.

MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.

PROTEÇÃO DE MENORES (regra absoluta, não negociável): há criança ou adolescente em cena. Sempre: roupa apropriada para a idade; nada revelador; nada sexualizado; nenhuma estética adulta (maquiagem, figurino ou pose de adulto); poses naturais e apropriadas à idade; peças com caimento normal, sem foco no corpo; contexto comercial, familiar e cotidiano coerente. Contato físico entre adulto e criança apenas em situação familiar ou cotidiana coerente com a relação declarada.

PRODUTOS (autoridade absoluta), 2 produtos DIFERENTES nesta ordem:
  · Produto 1 (imagem 1): "Família Entre Nós — Criança 1" (camiseta infantil) — camiseta infantil com estampa de família de ursinhos
  · Produto 2 (imagem 2): "Família Entre Nós — Criança 2" (camiseta infantil) — camiseta infantil com estampa de família de ursinhos, variação
  · Cada produto aparece exatamente uma vez; nunca troque, funda ou duplique produtos.

COMPOSIÇÃO DE PESSOAS (contrato): exatamente 4 pessoas em quadro.
  · Pessoa 1 (principal): menino 8 anos, criança de 6 a 9 anos — veste "Família Entre Nós — Criança 1" (camiseta infantil).
  · Pessoa 2 (apoio): menina 5 anos, criança de 3 a 5 anos, irmão ou irmã da Pessoa 1 — veste "Família Entre Nós — Criança 2" (camiseta infantil).
  · Pessoa 3 (apoio): mulher 36 anos, mãe da Pessoa 1 — não usa o produto.
  · Pessoa 4 (apoio): homem 38 anos, pai da Pessoa 1 — não usa o produto.

OLHAR: as pessoas olham diretamente para a câmera, com expressão natural.

INTERAÇÃO (foto de grupo): reúnem-se para uma foto de grupo espontânea, próximos uns dos outros, em alturas naturais (adultos em pé, crianças à frente), sem pose de estúdio. Mãos: ombros próximos, braços soltos ao lado do corpo ou em volta dos ombros de quem está ao lado; ninguém segura objetos.

ÂNGULO LIFESTYLE COTIDIANO: as pessoas em ação natural no dia a dia, vivendo um momento real — nunca posadas nem paradas olhando para o nada. Cenário: sala de estar acolhedora com sofá, manta e luz natural lateral.

VESTUÁRIO DAS CRIANÇAS (política da marca): pernas totalmente cobertas — preferir calça, jeans, sarja, legging apropriada ou peças compridas; nenhuma composição que exponha demais as pernas; sem shorts curtos; sem saias curtas; roupas casuais infantis, apropriadas à idade.

MARCA (Entre Nós):
  · Posicionamento: camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa.
  · Linguagem visual: editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo, luz natural quente e suave, hora dourada ou luz de janela, materiais tácteis e domésticos: tecidos, madeira, linho, papel.
  · Paleta da marca (guia de cor da CENA, nunca do produto): creme e bege quente; bordô/vinho profundo; marrom terroso; navy; off-white.
  · Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.
  · Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.
  · Crianças em cena sempre à vontade e em interação real com o adulto.

NICHO (Moda / Vestuário):
  · Materiais e sinais de uso real: algodão, trama de tecido visível, costuras e acabamento, etiqueta discreta.
  · Público: compra pelo caimento e pelo estilo, não só pela estampa; quer ver a peça vestida em corpo real; compara tecido, acabamento e tamanho antes de decidir.

CONTEXTO DA CENA: sala de estar acolhedora com sofá, manta e luz natural lateral. Elemento de apoio, discreto: manta de tricô jogada no encosto. Contexto coerente e contemporâneo, sem caricatura nem cenário turístico óbvio.

EVITAR (não incluir na cena, mesmo que outra regra sugira algo parecido): qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado; estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans); clima de propaganda de margarina; cenário de imobiliária sem sinal de uso; peça deformada ou com proporção irreal; tecido liso como vetor, sem trama; produto parecendo adesivo colado na foto.

FORMATO: Feed 4:5 vertical (1080×1350).
```

### FeedbackSnapshot

```json
{
  "creative_id": "33333333-3333-4333-8333-333333333333",
  "plan_id": "plan_550a8363314ab5357e46e066",
  "plan_schema_version": 2,
  "compiler_version": 2,
  "prompt_version": 2,
  "prompt_sha256": "7ff0cac79c7b87e7479b7ef734a19a6bf3f82d0c23cf93d9ec17332d9a9628d7",
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "angle": "LIFESTYLE_COTIDIANO",
  "product_ids": [
    "familia-crianca1",
    "familia-crianca2"
  ],
  "subjects": [
    {
      "role": "primary",
      "label": "menino 8 anos",
      "age_band": "child_6_9",
      "is_minor": true,
      "product_use": "wears",
      "role_hint": null,
      "relation_to_primary": null
    },
    {
      "role": "supporting",
      "label": "menina 5 anos",
      "age_band": "child_3_5",
      "is_minor": true,
      "product_use": "wears",
      "role_hint": "sibling",
      "relation_to_primary": "sibling"
    },
    {
      "role": "supporting",
      "label": "mulher 36 anos",
      "age_band": "adult",
      "is_minor": false,
      "product_use": "none",
      "role_hint": "mother",
      "relation_to_primary": "mother"
    },
    {
      "role": "supporting",
      "label": "homem 38 anos",
      "age_band": "adult",
      "is_minor": false,
      "product_use": "none",
      "role_hint": "father",
      "relation_to_primary": "father"
    }
  ],
  "people_count": 4,
  "interaction": "group_photo",
  "composition_source": "explicit",
  "composition_key": "p4|child_6_9+sibling+mother+father|group_photo",
  "pose_risk": "high",
  "warnings": [
    "people_count_risk:4"
  ],
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "placement": "FEED_4X5",
  "quality": "medium",
  "gaze_mode": "camera",
  "minor_safety_applied": true,
  "flags": {
    "normalize_references": null
  },
  "model": {
    "requested": "gpt-image-2",
    "served": null
  },
  "asset_sha256": null
}
```

### GenerationDraft

```json
{
  "mode": "creative",
  "objective": "clean_creative",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "multi_product",
  "product_ids": [
    "familia-crianca1",
    "familia-crianca2"
  ],
  "angle_id": "LIFESTYLE_COTIDIANO",
  "placement_id": "FEED_4X5",
  "quality": "medium",
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "persona_mode": "automatic",
  "persona": null,
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "persona": {
        "label": "menino 8 anos",
        "age_band": "child_6_9"
      },
      "wears_product_id": "familia-crianca1",
      "prominence": "hero",
      "age_band": "child_6_9"
    },
    {
      "id": "s2",
      "role": "supporting",
      "persona": {
        "label": "menina 5 anos",
        "age_band": "child_3_5"
      },
      "wears_product_id": "familia-crianca2",
      "prominence": "secondary",
      "age_band": "child_3_5",
      "relation_to_primary": "sibling"
    },
    {
      "id": "s3",
      "role": "supporting",
      "persona": {
        "label": "mulher 36 anos",
        "age_band": "adult"
      },
      "wears_product_id": null,
      "prominence": "secondary",
      "age_band": "adult",
      "relation_to_primary": "mother"
    },
    {
      "id": "s4",
      "role": "supporting",
      "persona": {
        "label": "homem 38 anos",
        "age_band": "adult"
      },
      "wears_product_id": null,
      "prominence": "secondary",
      "age_band": "adult",
      "relation_to_primary": "father"
    }
  ],
  "interaction": "group_photo",
  "scene_picks": {
    "acao": 4
  },
  "context": {
    "mode": "custom",
    "context_id": "entre_nos_sala",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral"
  },
  "funnel_stage": null,
  "remarketing": null,
  "funnel": null,
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "gaze_mode": "camera",
  "plan_schema_version": 2,
  "prompt_version": 2,
  "seed": 100,
  "plan_warnings": [
    "people_count_risk:4"
  ],
  "actions": {
    "again": {
      "seed": 100,
      "scene_picks": {
        "acao": 4
      },
      "gaze_mode": "camera"
    },
    "variation": {
      "seed": null,
      "scene_picks": null,
      "gaze_mode": "auto"
    }
  },
  "source": {
    "creative_id": "33333333-3333-4333-8333-333333333333",
    "plan_id": "plan_550a8363314ab5357e46e066",
    "plan_schema_version": 2,
    "compiler_version": 2
  },
  "carried": [
    "mode",
    "objective",
    "product_ids",
    "angle_id",
    "placement_id",
    "quality",
    "brand_kit",
    "niche_kit",
    "subjects",
    "interaction",
    "context",
    "copy",
    "gaze_mode",
    "scene_picks",
    "seed"
  ]
}
```

