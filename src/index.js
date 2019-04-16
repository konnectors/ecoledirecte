const {
  BaseKonnector,
  requestFactory,
  saveFiles,
  log,
  errors,
  mkdirp
} = require('cozy-konnector-libs')
const cheerio = require('cheerio')
const groupBy = require('lodash/groupBy')
const bluebird = require('bluebird')

class EcoleDirecteConnector extends BaseKonnector {
  constructor() {
    super()
    this.requestInstance = requestFactory({
      // debug: 'json',
      cheerio: false,
      json: true,
      jar: true
    })
  }

  async fetch(fields) {
    log('info', 'Authenticating ...')
    await this.authenticate(fields.login, fields.password)
    log('info', 'Successfully logged in')

    await this.initEtablissementFolder(fields)
    await this.initElevesFolders(fields)

    for (const eleve of this.account.profile.eleves) {
      const eleveFolder = this.folders[eleve.id]
      await this.fetchEleveRessources(eleve, eleveFolder)
      await this.fetchEleveHomeWorks(eleve, eleveFolder)
    }
  }

  async authenticate(identifiant, motdepasse) {
    try {
      let { accounts } = await this.request(
        'https://api.ecoledirecte.com/v3/login.awp',
        { identifiant, motdepasse }
      )
      if (accounts.length > 0) {
        log('warn', `There are ${accounts.length}, taking the main one`)
      }
      this.account = accounts.find(account => account.main)
    } catch (err) {
      log('error', `Error code ${err}`)
      throw new Error(errors.LOGIN_FAILED)
    }
  }

  async initEtablissementFolder(fields) {
    const { nomEtablissement } = this.account
    fields.folderPath = `${fields.folderPath}/${nomEtablissement}`
    await mkdirp(fields.folderPath)
  }
  async initElevesFolders(fields) {
    this.folders = {}
    for (const eleve of this.account.profile.eleves) {
      const eleveFolder = `${fields.folderPath}/${
        this.account.anneeScolaireCourante
      } - ${eleve.classe.libelle} (${eleve.prenom})`
      await mkdirp(eleveFolder)
      this.folders[eleve.id] = eleveFolder
    }
  }

  async fetchEleveHomeWorks(eleve, eleveFolder) {
    const cahierTexte = await this.request(
      `https://api.ecoledirecte.com/v3/Eleves/${
        eleve.id
      }/cahierdetexte.awp?verbe=get&`
    )

    let devoirs = await bluebird.map(Object.keys(cahierTexte), date =>
      this.request(
        `https://api.ecoledirecte.com/v3/Eleves/${
          eleve.id
        }/cahierdetexte/${date}.awp?verbe=get&`
      )
    )
    devoirs = devoirs.reduce((memo, doc) => {
      const matieres = doc.matieres.map(matiere => ({
        ...matiere,
        date: doc.date
      }))
      return memo.concat(matieres)
    }, [])

    devoirs = groupBy(devoirs, 'matiere')

    for (const matiere in devoirs) {
      for (const devoirsMatiere of devoirs[matiere]) {
        if (devoirsMatiere.aFaire) {
          const matiereFolder = `${eleveFolder}/${matiere}`
          await mkdirp(matiereFolder)
          const readme = cheerio
            .load(
              Buffer.from(devoirsMatiere.aFaire.contenu, 'base64').toString(
                'utf8'
              )
            )
            .text()
          await saveFiles(
            [
              {
                filestream: readme,
                filename: `${devoirsMatiere.date} Instructions.txt`
              }
            ],
            matiereFolder,
            {
              validateFile: () => true,
              shouldReplaceFile: () => true
            }
          )

          await saveFiles(
            devoirsMatiere.aFaire.ressourceDocuments
              .filter(fichier => fichier.taille < 10000000)
              .map(fichier => {
                return {
                  fileurl:
                    'https://api.ecoledirecte.com/v3/telechargement.awp?verbe=get',
                  filename: fichier.libelle,
                  requestOptions: {
                    method: 'POST',
                    form: {
                      token: this.token,
                      leTypeDeFichier: fichier.type,
                      fichierId: fichier.id,
                      anneeMessages: ''
                    }
                  }
                }
              }),
            matiereFolder,
            {
              requestInstance: this.requestInstance,
              contentType: true,
              concurrency: 8
            }
          )
        }
      }
    }
  }

  async fetchEleveRessources(eleve, eleveFolder) {
    const classId = eleve.classe.id
    const { matieres } = await this.request(
      `https://api.ecoledirecte.com/v3/R/${classId}/viedelaclasse.awp?verbe=get&`
    )

    for (const matiere of matieres) {
      const matiereFolder = `${eleveFolder}/${matiere.libelle}`
      await mkdirp(matiereFolder)
      const readme = cheerio
        .load(Buffer.from(matiere.contenu, 'base64').toString('utf8'))
        .text()
      await saveFiles(
        [{ filestream: readme, filename: 'Instructions.txt' }],
        matiereFolder,
        {
          validateFile: () => true,
          shouldReplaceFile: () => true
        }
      )
      await saveFiles(
        matiere.fichiers
          .filter(fichier => fichier.taille < 10000000)
          .map(fichier => {
            return {
              fileurl:
                'https://api.ecoledirecte.com/v3/telechargement.awp?verbe=get',
              filename: `${matiere.dateMiseAJour} ${fichier.libelle}`,
              requestOptions: {
                method: 'POST',
                form: {
                  token: this.token,
                  leTypeDeFichier: fichier.type,
                  fichierId: fichier.id,
                  anneeMessages: ''
                }
              }
            }
          }),
        matiereFolder,
        {
          requestInstance: this.requestInstance,
          contentType: true,
          concurrency: 8
        }
      )
    }
  }

  async request(url, formData = { token: this.token }) {
    const { token, data, code } = await this.requestInstance.post(url, {
      form: {
        data: JSON.stringify(formData)
      }
    })

    if (code !== 200) {
      throw new Error(code)
    }

    this.token = token
    return data
  }
}

const connector = new EcoleDirecteConnector()

connector.run()
